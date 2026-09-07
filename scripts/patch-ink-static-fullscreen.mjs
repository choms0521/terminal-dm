import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// npm may hoist Ink above terminal-dm instead of installing it in this package's
// own node_modules directory. Resolve Ink with Node's module resolver so the
// patch works for local, global, nested and hoisted installations alike.
const inkEntryPath = fileURLToPath(import.meta.resolve("ink"));
const inkBuildDir = path.dirname(inkEntryPath);
const inkPath = path.join(inkBuildDir, "ink.js");
const source = await fs.readFile(inkPath, "utf8");
const original = "const isFullscreen = isTty && outputHeight >= viewportRows;";
const replacement = `// Static output is committed above the interactive frame and also occupies
        // terminal rows. Ignoring it adds a trailing newline to an otherwise full
        // viewport, leaving an unwanted blank row below fixed footers.
        const staticOutputHeight = this.fullStaticOutput === ''
            ? 0
            : this.fullStaticOutput.split('\\n').length - (this.fullStaticOutput.endsWith('\\n') ? 1 : 0);
        const isFullscreen = isTty && outputHeight + staticOutputHeight >= viewportRows;`;

if (!source.includes(replacement)) {
  if (!source.includes(original)) {
    throw new Error("지원하지 않는 Ink 버전입니다: fullscreen 판정 코드를 찾지 못했습니다.");
  }
  await fs.writeFile(inkPath, source.replace(original, replacement));
}

const logUpdatePath = path.join(inkBuildDir, "log-update.js");
let logUpdateSource = await fs.readFile(logUpdatePath, "utf8");
const cursorHelper = `// With no trailing newline the terminal is already on the final visible row,
// not on the virtual row after it. Cursor positioning must use that row as its
// origin or IME cursors land on the border above and subsequent erases drift.
const cursorBottomLine = (str, visibleCount) => visibleCount - (str.endsWith('\\n') ? 0 : 1);`;

if (!logUpdateSource.includes(cursorHelper)) {
  const visibleCountDeclaration =
    "const visibleLineCount = (lines, str) => str.endsWith('\\n') ? lines.length - 1 : lines.length;";
  if (!logUpdateSource.includes(visibleCountDeclaration)) {
    throw new Error("지원하지 않는 Ink 버전입니다: cursor 행 계산 코드를 찾지 못했습니다.");
  }
  logUpdateSource = logUpdateSource.replace(
    visibleCountDeclaration,
    `${visibleCountDeclaration}\n${cursorHelper}`,
  );
  logUpdateSource = logUpdateSource
    .replaceAll(
      "buildCursorSuffix(visibleCount, activeCursor)",
      "buildCursorSuffix(cursorBottomLine(str, visibleCount), activeCursor)",
    )
    .replaceAll(
      "visibleLineCount: visibleCount,",
      "visibleLineCount: cursorBottomLine(str, visibleCount),",
    )
    .replaceAll(
      "stream.write(buildCursorSuffix(visibleLineCount(lines, str), activeCursor));",
      "const visibleCount = visibleLineCount(lines, str);\n            stream.write(buildCursorSuffix(cursorBottomLine(str, visibleCount), activeCursor));",
    );
  await fs.writeFile(logUpdatePath, logUpdateSource);
}
