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
): Promise<void> {
  const ids: number[] = [];
  try {
    await write("\x1b[2J\x1b[H");
    for (const [index, image] of images.entries()) {
      const png = await readFile(image.path);
      const size = getPreviewSize(image.width, image.height, maxColumns, maxRows);
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

/** Ink must be suspended before this function takes ownership of stdin. */
export async function waitForGalleryKey(stdin: NodeJS.ReadStream, signal: AbortSignal): Promise<void> {
  if (signal.aborted || stdin.destroyed || stdin.readableEnded) return;
  const wasRaw = stdin.isRaw;
  let onReadable: () => void = () => {};
  let onEnd: () => void = () => {};
  let onError: (error: Error) => void = () => {};
  try {
    stdin.setRawMode(true);
    stdin.ref();
    await new Promise<void>((resolve, reject) => {
      onEnd = resolve;
      onError = reject;
      onReadable = () => {
        // Consume the complete chunk (e.g. an arrow escape sequence or paste),
        // so the return key and its trailing bytes cannot reach the composer.
        if (stdin.read() !== null) resolve();
      };
      stdin.on("readable", onReadable);
      stdin.once("end", onEnd);
      stdin.once("close", onEnd);
      stdin.once("error", onError);
      signal.addEventListener("abort", onEnd, { once: true });
      onReadable();
    });
  } finally {
    stdin.off("readable", onReadable);
    stdin.off("end", onEnd);
    stdin.off("close", onEnd);
    stdin.off("error", onError);
    signal.removeEventListener("abort", onEnd);
    stdin.setRawMode(wasRaw ?? false);
    stdin.unref();
  }
}

export function getPreviewSize(
  width: number,
  height: number,
  maxColumns: number,
  maxRows: number,
): { columns: number; rows: number } {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    throw new RangeError("Image dimensions must be positive finite numbers");
  }
  positiveInteger(maxColumns, "maxColumns");
  positiveInteger(maxRows, "maxRows");
  // Approximate terminal cells as twice as tall as they are wide.
  const columns = Math.max(1, Math.min(maxColumns, Math.floor((maxRows * 2 * width) / height)));
  const rows = Math.max(1, Math.min(maxRows, Math.ceil((columns * height) / (width * 2))));
  return { columns, rows };
}
