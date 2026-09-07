import { readFile, unlink } from "node:fs/promises";

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
  options: { columns: number; rows?: number },
): string {
  positiveInteger(options.columns, "columns");
  if (options.rows !== undefined) positiveInteger(options.rows, "rows");
  if (png.byteLength === 0) throw new RangeError("Image data must not be empty");

  const encoded = Buffer.from(png).toString("base64");
  const dimensions = `c=${options.columns}${options.rows === undefined ? "" : `,r=${options.rows}`}`;
  const packets: string[] = [];
  // The protocol limits each base64 payload to 4096 ASCII bytes.
  for (let offset = 0; offset < encoded.length; offset += 4096) {
    const chunk = encoded.slice(offset, offset + 4096);
    const more = offset + chunk.length < encoded.length ? 1 : 0;
    const header = offset === 0 ? `a=T,f=100,t=d,q=2,C=1,${dimensions},` : "";
    packets.push(`\x1b_G${header}m=${more};${chunk}\x1b\\`);
  }
  return packets.join("");
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

export async function renderImagePreview(
  result: { path: string; width: number; height: number },
  maxColumns: number,
  maxRows: number,
  write: (text: string) => void | Promise<void>,
): Promise<void> {
  try {
    const png = await readFile(result.path);
    const size = getPreviewSize(result.width, result.height, maxColumns, maxRows);
    const sequence = generateKittyImage(png, size);
    // C=1 keeps the image placement from moving the cursor; reserve its rows explicitly.
    await write(`${sequence}${"\n".repeat(size.rows)}`);
  } finally {
    await unlink(result.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
