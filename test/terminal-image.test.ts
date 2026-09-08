import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";

import {
  createGalleryInput,
  generateKittyImage,
  getPreviewSize,
  getTerminalImageCapability,
  deleteImagePreviews,
  renderImageGallery,
  waitForGalleryKey,
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


test("gallery reserves rows before placement and removes every placement after dismissal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const images = ["first", "second"].map((name) => ({ path: join(directory, name), width: 400, height: 200 }));
  for (const image of images) await writeFile(image.path, Uint8Array.of(1, 2, 3));
  let output = "";
  await renderImageGallery(images, 40, 20, (text) => { output += text; }, "Return", async () => {
    assert.equal((output.match(/\x1b_Ga=T/g) ?? []).length, 2);
    assert.ok(output.includes("\r\n".repeat(10) + "\x1b[10A\x1b_Ga=T"));
    assert.ok(output.endsWith("Return\r\n"));
    assert.ok(!output.includes("a=d"));
    for (const image of images) await access(image.path);
  });
  const ids = [...output.matchAll(/a=T[^;]+i=(\d+)/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, 2);
  for (const id of ids) assert.ok(output.includes(`a=d,d=I,i=${id},q=2`));
  await deleteImagePreviews(images);
  for (const image of images) await assert.rejects(access(image.path), { code: "ENOENT" });
});

test("gallery clears partial placements on output failure; caller can clean all files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = { path: join(directory, "capture.png"), width: 1, height: 1 };
  await writeFile(image.path, Uint8Array.of(1));
  let cleanup = "";
  await assert.rejects(renderImageGallery([image], 40, 20, (text) => {
    if (text.includes("a=T")) throw new Error("Output failed");
    cleanup += text;
  }, "Return", async () => assert.fail("Must not wait after output failure")), /Output failed/);
  assert.ok(cleanup.includes("a=d,d=I"));
  await deleteImagePreviews([image]);
  await assert.rejects(access(image.path), { code: "ENOENT" });
});

test("cleanup attempts later paths even when one deletion fails and tolerates missing files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  await writeFile(path, Uint8Array.of(1));
  const images = [directory, join(directory, "missing"), path].map((path) => ({ path, width: 1, height: 1 }));
  await assert.rejects(deleteImagePreviews(images));
  await assert.rejects(access(path), { code: "ENOENT" });
});

for (const ending of ["key", "abort", "end", "error"] as const) {
  test(`gallery input releases raw mode and listeners on ${ending}`, async () => {
    const abort = new AbortController();
    const stdin = Object.assign(new PassThrough(), {
      isRaw: false,
      setRawMode(raw: boolean) { this.isRaw = raw; return this; },
      ref() { return this; },
      unref() { return this; },
    });
    const waiting = waitForGalleryKey(stdin as unknown as NodeJS.ReadStream, abort.signal);
    assert.equal(stdin.isRaw, true);
    if (ending === "key") stdin.write("q\r");
    else if (ending === "abort") abort.abort();
    else if (ending === "end") stdin.end();
    else stdin.emit("error", new Error("Input failed"));
    if (ending === "error") await assert.rejects(waiting, /Input failed/);
    else await waiting;
    assert.equal(stdin.isRaw, false);
    assert.equal(stdin.listenerCount("readable"), 0);
    assert.equal(stdin.listenerCount("error"), 0);
    assert.equal(stdin.read(), null);
    stdin.destroy();
  });
}


test("small previews stay within their native cell footprint, including subcell crops", () => {
  assert.deepEqual(getPreviewSize(130, 302, 40, 40, { width: 10, height: 20 }),
    { columns: 13, rows: 16 });
  assert.deepEqual(getPreviewSize(3, 7, 40, 40, { width: 10, height: 20 }),
    { columns: 1, rows: 1 });
});

test("large previews downscale to column and row limits using cell pixels", () => {
  assert.deepEqual(getPreviewSize(4000, 2000, 40, 20, { width: 10, height: 20 }),
    { columns: 40, rows: 10 });
  assert.deepEqual(getPreviewSize(1000, 4000, 40, 20, { width: 10, height: 20 }),
    { columns: 10, rows: 20 });
});

test("preview sizing preserves pixel aspect ratio for nonstandard cells within cell rounding", () => {
  const cells = { width: 9, height: 15 };
  const size = getPreviewSize(900, 600, 40, 20, cells);
  assert.deepEqual(size, { columns: 40, rows: 16 });
  assert.equal(size.columns * cells.width / (size.rows * cells.height), 900 / 600);
  const rounded = getPreviewSize(130, 302, 40, 40, cells);
  assert.ok(rounded.columns * cells.width >= 130);
  assert.ok(rounded.columns * cells.width < 130 + cells.width);
  assert.ok(rounded.rows * cells.height >= 302);
  assert.ok(rounded.rows * cells.height < 302 + cells.height);
});

test("missing cell size retains legacy sizing and invalid explicit cell sizes are rejected", () => {
  assert.deepEqual(getPreviewSize(130, 302, 40, 40, undefined), { columns: 34, rows: 40 });
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => getPreviewSize(100, 100, 40, 20, { width: value, height: 20 }), RangeError);
    assert.throws(() => getPreviewSize(100, 100, 40, 20, { width: 10, height: value }), RangeError);
  }
});

function galleryStdin() {
  return Object.assign(new PassThrough(), {
    isRaw: false,
    setRawMode(raw: boolean) { this.isRaw = raw; return this; },
    ref() { return this; },
    unref() { return this; },
  });
}

test("cell query parses split replies and retains keys before and after the reply", async () => {
  for (const early of [true, false]) {
    const stdin = galleryStdin();
    const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, new AbortController().signal);
    try {
      const size = input.queryCellSize((request) => {
        assert.equal(request, "\x1b[16t");
        stdin.write(`${early ? "q" : ""}\x1b[6;2`);
        setImmediate(() => stdin.write(`0;10t${early ? "" : "\r"}`));
      });
      assert.deepEqual(await size, { width: 10, height: 20 });
      assert.equal(stdin.isRaw, true);
      await input.waitForKey();
      assert.equal(stdin.read(), null);
    } finally {
      input.dispose();
      assert.equal(stdin.isRaw, false);
      assert.equal(stdin.listenerCount("readable"), 0);
      stdin.destroy();
    }
  }
});

test("cell query times out gracefully and filters late replies before dismissal", async () => {
  const stdin = galleryStdin();
  const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, new AbortController().signal);
  try {
    assert.equal(await input.queryCellSize(() => {}, 5), undefined);
    let dismissed = false;
    const waiting = input.waitForKey().then(() => { dismissed = true; });
    stdin.write("\x1b[6;20;10t");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dismissed, false);
    stdin.write("\r");
    await waiting;
  } finally {
    input.dispose();
    stdin.destroy();
  }
});

test("invalid cell reports fall back without treating protocol bytes as dismissal", async () => {
  for (const reply of ["\x1b[6;0;10t", "\x1b[6;20;t", "\x1b[6;20;10;2t", "\x1b[6;nope;10t"]) {
    const stdin = galleryStdin();
    const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, new AbortController().signal);
    try {
      assert.equal(await input.queryCellSize(() => { stdin.write(reply); }), undefined);
      let dismissed = false;
      const waiting = input.waitForKey().then(() => { dismissed = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(dismissed, false);
      stdin.write("q");
      await waiting;
    } finally {
      input.dispose();
      stdin.destroy();
    }
  }
});

test("cell query retains an early dismissal key when no report arrives", async () => {
  const stdin = galleryStdin();
  const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, new AbortController().signal);
  try {
    assert.equal(await input.queryCellSize(() => { stdin.write("q\r"); }, 5), undefined);
    await input.waitForKey();
    assert.equal(stdin.read(), null);
  } finally {
    input.dispose();
    stdin.destroy();
  }
});

for (const ending of ["abort", "end", "error", "output"] as const) {
  test(`cell query releases raw mode and listeners after ${ending}`, async () => {
    const stdin = galleryStdin();
    stdin.isRaw = true;
    const abort = new AbortController();
    const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, abort.signal);
    try {
      const querying = input.queryCellSize(() => {
        if (ending === "abort") abort.abort();
        else if (ending === "end") stdin.end();
        else if (ending === "error") stdin.emit("error", new Error("Input failed"));
        else throw new Error("Output failed");
      });
      if (ending === "output") await assert.rejects(querying, /Output failed/);
      else assert.equal(await querying, undefined);
      if (ending === "error") await assert.rejects(input.waitForKey(), /Input failed/);
    } finally {
      input.dispose();
      assert.equal(stdin.isRaw, true);
      for (const event of ["readable", "end", "close", "error"]) assert.equal(stdin.listenerCount(event), 0);
      stdin.destroy();
    }
  });
}

test("gallery reserves the smaller native row count before placement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-native-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const image = { path: join(directory, "capture.png"), width: 130, height: 302 };
  await writeFile(image.path, Uint8Array.of(1));
  let output = "";
  await renderImageGallery([image], 40, 40, (text) => { output += text; }, "Return", async () => {
    assert.ok(output.includes("\r\n".repeat(16) + "\x1b[16A\x1b_Ga=T"));
    assert.match(output, /c=13,r=16,/);
    assert.ok(output.endsWith("\x1b[16B\r\nReturn\r\n"));
  }, { width: 10, height: 20 });
});


test("malformed reports preserve a dismissal key in the same chunk", async () => {
  const stdin = galleryStdin();
  const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, new AbortController().signal);
  try {
    assert.equal(await input.queryCellSize(() => { stdin.write("\x1b[6;nope;10tq"); }), undefined);
    await input.waitForKey();
    assert.equal(stdin.read(), null);
  } finally {
    input.dispose();
    stdin.destroy();
  }
});

test("a standalone Escape key still dismisses after querying cell size", async () => {
  const stdin = galleryStdin();
  const input = createGalleryInput(stdin as unknown as NodeJS.ReadStream, new AbortController().signal);
  try {
    assert.deepEqual(await input.queryCellSize(() => { stdin.write("\x1b[6;20;10t"); }),
      { width: 10, height: 20 });
    stdin.write("\x1b");
    await input.waitForKey();
    assert.equal(stdin.read(), null);
  } finally {
    input.dispose();
    stdin.destroy();
  }
});
