import assert from "node:assert/strict";
import { access, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateKittyImage,
  getPreviewSize,
  getTerminalImageCapability,
  renderImagePreview,
} from "../src/ui/terminal-image.js";

test("terminal capability recognizes supported names in either environment field", () => {
  for (const name of ["ghostty", "xterm-kitty", "WezTerm", "XTERM-GHOSTTY"]) {
    assert.equal(getTerminalImageCapability({ TERM: name }), "kitty");
    assert.equal(getTerminalImageCapability({ TERM_PROGRAM: name }), "kitty");
  }
  for (const env of [{}, { TERM: "xterm-256color" }, { TERM_PROGRAM: "Apple_Terminal" }]) {
    assert.equal(getTerminalImageCapability(env), "none");
  }
});

test("Kitty image sets PNG transfer, quiet mode, cursor policy, and dimensions", () => {
  assert.equal(
    generateKittyImage(Uint8Array.of(0, 255, 127), { columns: 40, rows: 10 }),
    "\x1b_Ga=T,f=100,t=d,q=2,C=1,c=40,r=10,m=0;AP9/\x1b\\",
  );
  assert.match(generateKittyImage(Uint8Array.of(1), { columns: 20 }), /c=20,m=0;/);
});

test("Kitty base64 chunks round-trip binary data on and across the 4096-byte boundary", () => {
  for (const length of [1, 3072, 3073, 6144, 7001]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
    const packets = [...generateKittyImage(bytes, { columns: 40 }).matchAll(/\x1b_G([^;]+);([^\x1b]*)\x1b\\/g)];
    assert.equal(packets.length, Math.ceil(Buffer.from(bytes).toString("base64").length / 4096));
    packets.forEach((packet, index) => {
      assert.ok(packet[2]!.length <= 4096);
      assert.equal(packet[2]!.length % 4, 0);
      assert.ok(packet[1]!.endsWith(`m=${index === packets.length - 1 ? 0 : 1}`));
      if (index > 0) assert.match(packet[1]!, /^m=[01]$/);
    });
    assert.deepEqual(Buffer.from(packets.map((packet) => packet[2]).join(""), "base64"), Buffer.from(bytes));
  }
});

test("Kitty generation rejects empty data and invalid placement dimensions", () => {
  assert.throws(() => generateKittyImage(new Uint8Array(), { columns: 40 }), /empty/);
  for (const value of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => generateKittyImage(Uint8Array.of(1), { columns: value }), RangeError);
    assert.throws(() => generateKittyImage(Uint8Array.of(1), { columns: 40, rows: value }), RangeError);
  }
});

test("preview sizing preserves approximate aspect ratio within both bounds", () => {
  assert.deepEqual(getPreviewSize(400, 200, 40, 20), { columns: 40, rows: 10 });
  assert.deepEqual(getPreviewSize(100, 1000, 40, 20), { columns: 4, rows: 20 });
  assert.deepEqual(getPreviewSize(10000, 1, 40, 20), { columns: 40, rows: 1 });
  assert.deepEqual(getPreviewSize(1, 10000, 40, 20), { columns: 1, rows: 20 });
});

test("preview sizing rejects invalid image dimensions and terminal bounds", () => {
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => getPreviewSize(value, 100, 40, 20), RangeError);
    assert.throws(() => getPreviewSize(100, value, 40, 20), RangeError);
  }
  for (const value of [0, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => getPreviewSize(100, 100, value, 20), RangeError);
    assert.throws(() => getPreviewSize(100, 100, 40, value), RangeError);
  }
});

test("rendering reserves rows and deletes the transient file after the consumer completes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  await writeFile(path, Uint8Array.of(0, 255, 127));
  let output = "";
  await renderImagePreview({ path, width: 400, height: 200 }, 40, 20, async (text) => {
    await access(path);
    output = text;
  });
  assert.ok(output.startsWith("\x1b_Ga=T"));
  assert.ok(output.endsWith("\x1b\\" + "\n".repeat(10)));
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("rendering deletes the transient file when writing fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  await writeFile(path, Uint8Array.of(1));
  await assert.rejects(renderImagePreview({ path, width: 100, height: 100 }, 40, 20, async () => {
    throw new Error("Output failed");
  }), /Output failed/);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("rendering deletes the transient file when generating fails", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  await writeFile(path, new Uint8Array());
  await assert.rejects(renderImagePreview({ path, width: 100, height: 100 }, 40, 20, () => {
    assert.fail("Should not write invalid data");
  }), /empty/);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("rendering cleans up after a read failure and tolerates an already missing file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  await symlink(join(directory, "missing.png"), path);
  await assert.rejects(renderImagePreview({ path, width: 100, height: 100 }, 40, 20, () => {
    assert.fail("Should not write unreadable data");
  }), { code: "ENOENT" });
  // Recreating the symlink proves the broken symlink itself was removed.
  await symlink(join(directory, "missing.png"), path);
  await rm(path);
  await assert.rejects(renderImagePreview({ path, width: 100, height: 100 }, 40, 20, () => {}), { code: "ENOENT" });
});
