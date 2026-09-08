import { readFile, unlink } from "node:fs/promises";

import type { ImagePreview } from "../domain.js";

export function getTerminalImageCapability(env: {
  TERM?: string;
  TERM_PROGRAM?: string;
}): "kitty" | "none" {
  const terminal = `${env.TERM ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
  return ["ghostty", "xterm-kitty", "wezterm"].some((name) => terminal.includes(name))
    ? "kitty"
    : "none";
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

export function generateKittyImage(
  png: Uint8Array,
  options: { columns: number; rows?: number; id?: number },
): string {
  positiveInteger(options.columns, "columns");
  if (options.rows !== undefined) positiveInteger(options.rows, "rows");
  if (options.id !== undefined) positiveInteger(options.id, "id");
  if (png.byteLength === 0) throw new RangeError("Image data must not be empty");

  const encoded = Buffer.from(png).toString("base64");
  const dimensions = `c=${options.columns}${options.rows === undefined ? "" : `,r=${options.rows}`}`;
  const packets: string[] = [];
  // The protocol limits each base64 payload to 4096 ASCII bytes.
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const chunk = encoded.slice(offset, offset + 4096);
    const more = offset + chunk.length < encoded.length ? 1 : 0;
    const header = offset === 0 ? `a=T,f=100,t=d,q=2,C=1,${dimensions},${options.id === undefined ? "" : `i=${options.id},`}` : "";
    packets.push(`\x1b_G${header}m=${more};${chunk}\x1b\\`);
  }
  return packets.join("");
}

/** Attempt every deletion even if one path fails. Only missing files are benign. */
export async function deleteImagePreviews(images: readonly ImagePreview[]): Promise<void> {
  const results = await Promise.allSettled(images.map(async ({ path }) => {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }));
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

// Explicit ids let us remove this gallery's placements, including scrolled
// images, without deleting graphics that belong to another terminal program.
let nextGalleryImageId = 0x54440000;

/** Caller owns the PNG files; this helper owns only the terminal placements. */
export async function renderImageGallery(
  images: readonly ImagePreview[],
  maxColumns: number,
  maxRows: number,
  write: (text: string) => void | Promise<void>,
  hint: string,
  waitForKey: () => Promise<void>,
  cellSize?: TerminalCellSize,
): Promise<void> {
  const ids: number[] = [];
  try {
    await write("\x1b[2J\x1b[H");
    for (const [index, image] of images.entries()) {
      const png = await readFile(image.path);
      const size = getPreviewSize(image.width, image.height, maxColumns, maxRows, cellSize);
      const id = nextGalleryImageId++;
      ids.push(id);
      const sequence = generateKittyImage(png, { ...size, id });
      // Reserve space BEFORE placement: with C=1 a placement near the bottom
      // can be clipped. Scrolling first and moving back up gives it full room.
      await write(`${index + 1}/${images.length}\r\n${"\r\n".repeat(size.rows)}\x1b[${size.rows}A${sequence}\x1b[${size.rows}B\r\n`);
    }
    await write(`${hint}\r\n`);
    await waitForKey();
  } finally {
    await write(ids.map((id) => `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`).join("") + "\x1b[2J\x1b[H");
  }
}

export interface TerminalCellSize {
  width: number;
  height: number;
}

/** Own input from the query through dismissal, while Ink is suspended. */
export function createGalleryInput(stdin: NodeJS.ReadStream, signal: AbortSignal) {
  const wasRaw = stdin.isRaw;
  let pending = "";
  let hasKey = false;
  let ended = signal.aborted || stdin.destroyed || stdin.readableEnded;
  const ownsInput = !ended;
  let inputError: Error | undefined;
  let disposed = false;
  let queried = false;
  let finishQuery: ((size?: TerminalCellSize) => void) | undefined;
  let finishWait: (() => void) | undefined;
  let partialTimer: ReturnType<typeof setTimeout> | undefined;

  const notify = () => {
    if (ended || inputError) finishQuery?.();
    if (hasKey || ended || inputError) finishWait?.();
  };
  const consume = () => {
    clearTimeout(partialTimer);
    while (pending.length > 0) {
      const report = /^\x1b\[6;([^t\x1b]*)t/.exec(pending);
      if (report) {
        const fields = report[1]!.split(";").map(Number);
        const [height, width] = fields;
        const valid = fields.length === 2 && Number.isSafeInteger(width) && width! > 0
          && Number.isSafeInteger(height) && height! > 0;
        finishQuery?.(valid ? { width: width!, height: height! } : undefined);
        pending = pending.slice(report[0].length);
      } else if (queried && (/^\x1b(?:\[(?:6(?:;[0-9;]*)?)?)?$/.test(pending))) {
        // Keep split replies together. A bare Escape is still a dismissal key;
        // an incomplete report is protocol traffic, not a keypress.
        if (!pending.startsWith("\x1b[6;")) {
          partialTimer = setTimeout(() => {
            hasKey = true;
            pending = "";
            notify();
          }, 150);
        }
        break;
      } else {
        hasKey = true;
        pending = pending.slice(1);
      }
    }
    notify();
  };
  const onReadable = () => {
    let chunk: Buffer | string | null;
    while ((chunk = stdin.read() as Buffer | string | null) !== null) {
      pending += chunk.toString();
      consume();
    }
  };
  const onEnd = () => { ended = true; notify(); };
  const onError = (error: Error) => { inputError = error; notify(); };

  if (!ended) {
    stdin.setRawMode(true);
    stdin.ref();
    stdin.on("readable", onReadable);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
    stdin.once("error", onError);
    signal.addEventListener("abort", onEnd, { once: true });
    onReadable();
  }

  return {
    async queryCellSize(
      write: (text: string) => void | Promise<void>,
      timeoutMs = 150,
    ): Promise<TerminalCellSize | undefined> {
      if (ended || disposed || inputError) return undefined;
      queried = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const response = new Promise<TerminalCellSize | undefined>((resolve) => {
        finishQuery = (size) => {
          clearTimeout(timer);
          finishQuery = undefined;
          resolve(size);
        };
        timer = setTimeout(() => finishQuery?.(), timeoutMs);
      });
      try {
        // CSI 16 t reports cell pixels as CSI 6 ; height ; width t.
        await write("\x1b[16t");
        return await response;
      } finally {
        clearTimeout(timer);
        finishQuery?.();
      }
    },
    async waitForKey(): Promise<void> {
      if (!hasKey && !ended && !inputError && !disposed) {
        await new Promise<void>((resolve) => { finishWait = resolve; });
      }
      finishWait = undefined;
      if (inputError) throw inputError;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimeout(partialTimer);
      finishQuery?.();
      finishWait?.();
      stdin.off("readable", onReadable);
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      stdin.off("error", onError);
      signal.removeEventListener("abort", onEnd);
      if (!ownsInput) return;
      // Match the raw mode that Ink left us, including abort/error exits.
      stdin.setRawMode(wasRaw ?? false);
      stdin.unref();
    },
  };
}

/** Ink must be suspended before this function takes ownership of stdin. */
export async function waitForGalleryKey(stdin: NodeJS.ReadStream, signal: AbortSignal): Promise<void> {
  const input = createGalleryInput(stdin, signal);
  try {
    await input.waitForKey();
  } finally {
    input.dispose();
  }
}

export function getPreviewSize(
  width: number,
  height: number,
  maxColumns: number,
  maxRows: number,
  cellSize?: TerminalCellSize,
): { columns: number; rows: number } {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError("Image dimensions must be positive finite numbers");
  }
  positiveInteger(maxColumns, "maxColumns");
  positiveInteger(maxRows, "maxRows");
  if (cellSize) {
    positiveInteger(cellSize.width, "cellSize.width");
    positiveInteger(cellSize.height, "cellSize.height");
    const nativeCols = Math.ceil(width / cellSize.width);
    const nativeRows = Math.ceil(height / cellSize.height);
    const columnLimit = Math.min(maxColumns, nativeCols);
    const rowLimit = Math.min(maxRows, nativeRows);
    // Scale in pixels, never above 1. Whole-cell rounding may add less than
    // one cell on either axis, but never exceeds the native cell footprint.
    const scale = Math.min(1, columnLimit * cellSize.width / width,
      rowLimit * cellSize.height / height);
    return {
      columns: Math.min(columnLimit, Math.max(1, Math.ceil(width * scale / cellSize.width))),
      rows: Math.min(rowLimit, Math.max(1, Math.ceil(height * scale / cellSize.height))),
    };
  }
  // Without a cell report, retain the legacy two-to-one cell approximation.
  const columns = Math.max(1, Math.min(maxColumns, Math.floor((maxRows * 2 * width) / height)));
  const rows = Math.max(1, Math.min(maxRows, Math.ceil((columns * height) / (width * 2))));
  return { columns, rows };
}
