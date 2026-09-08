import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { render } from "ink";
import { createElement } from "react";

import type { ChatConnector, ChatSnapshot, ImageGalleryResult } from "../src/domain.js";
import { App } from "../src/ui/app.js";

class MemoryOutput extends Writable {
  isTTY = true;
  columns = 100;
  rows = 36;
  output = "";

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

class PreviewConnector extends EventEmitter implements ChatConnector {
  captures = 0;
  readonly sent: string[] = [];
  readonly snapshot: ChatSnapshot = {
    state: "connected",
    activeConversationId: "room",
    conversations: [{ id: "room", provider: "kakaotalk", title: "Preview room", href: "kakaotalk:room", unread: false }],
    messages: [
      { id: "old-photo", threadId: "room", sender: "Peer", kind: "image", text: "" },
      { id: "text", threadId: "room", sender: "Peer", kind: "text", text: "Text only" },
      { id: "sticker", threadId: "room", sender: "Peer", kind: "sticker", text: "" },
      { id: "new-photo", threadId: "room", sender: "Peer", kind: "image", text: "" },
    ],
  };

  constructor(private readonly capture: () => Promise<ImageGalleryResult>) { super(); }
  getSnapshot(): ChatSnapshot { return this.snapshot; }
  async start(): Promise<void> { this.emit("snapshot", this.snapshot); }
  async stop(): Promise<void> {}
  async refresh(): Promise<void> {}
  async loadMoreConversations(): Promise<number> { return 0; }
  async loadOlderMessages(): Promise<number> { return 0; }
  async openConversation(): Promise<void> {}
  async sendMessage(text: string): Promise<void> { this.sent.push(text); }
  async previewImages(): Promise<ImageGalleryResult> {
    this.captures += 1;
    return this.capture();
  }
}

async function until(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), description);
}

async function mount(t: TestContext, terminal: string, connector: PreviewConnector) {
  const previousTerm = process.env.TERM;
  const previousProgram = process.env.TERM_PROGRAM;
  process.env.TERM = "xterm-256color";
  process.env.TERM_PROGRAM = terminal;
  const stdout = new MemoryOutput();
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() { return this; },
    ref() { return this; },
    unref() { return this; },
  });
  const instance = render(createElement(App, { connector, initialLanguage: "en" }), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
    kittyKeyboard: { mode: "disabled" },
    maxFps: 120,
  });
  t.after(async () => {
    instance.unmount();
    await instance.waitUntilExit();
    instance.cleanup();
    stdin.destroy();
    stdout.destroy();
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    if (previousProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = previousProgram;
  });
  await until(() => stdout.output.includes("Text only"), "App renders the fake conversation");
  await delay(20);
  return {
    stdout,
    stdin,
    instance,
    async input(value: string) {
      stdin.write(value);
      await delay(30);
      await instance.waitUntilRenderFlush();
    },
  };
}

test("App /preview rejects unsupported terminals before capture", async (t) => {
  const connector = new PreviewConnector(async () => ({ unavailable: "no-image" }));
  const app = await mount(t, "Apple_Terminal", connector);
  await app.input("/preview\r");
  await until(() => app.stdout.output.includes("This terminal cannot display images."), "Unsupported terminal notice is shown");
  assert.equal(connector.captures, 0);
  assert.deepEqual(connector.sent, []);
  assert.ok(!app.stdout.output.includes("\x1b_G"));
});


const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4N8AAAAASUVORK5CYII=", "base64");

test("App /p renders all images, suspends redraw/input, then restores chat and deletes files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const images = [1, 2, 3].map((i) => ({ path: join(directory, `capture-${i}.png`), width: i, height: 1 }));
  const connector = new PreviewConnector(async () => {
    await Promise.all(images.map((image) => writeFile(image.path, png)));
    return { images };
  });
  const app = await mount(t, "ghostty", connector);
  await app.input("/p\r");
  await until(() => app.stdout.output.includes("Press Esc/q"), "Gallery waits for a key");
  assert.equal(connector.captures, 1);
  assert.equal((app.stdout.output.match(/\x1b_Ga=T/g) ?? []).length, 3);
  assert.ok(app.stdout.output.indexOf("1/3") < app.stdout.output.indexOf("2/3"));
  assert.ok(app.stdout.output.indexOf("2/3") < app.stdout.output.indexOf("3/3"));
  for (const image of images) await access(image.path);
  const suspendedOutput = app.stdout.output;
  connector.emit("snapshot", { ...connector.snapshot, detail: "Updated while viewing gallery" });
  app.stdout.columns = 90;
  app.stdout.emit("resize");
  await delay(100);
  assert.equal(app.stdout.output, suspendedOutput, "No Ink or resize output overwrites the gallery");
  await app.input("q");
  await until(() => app.stdout.output.includes("Gallery closed."), "Chat resumes after keypress");
  for (const image of images) await assert.rejects(access(image.path), { code: "ENOENT" });
  assert.equal((app.stdout.output.match(/\x1b_Ga=d,d=I/g) ?? []).length, 3);
  assert.ok(app.stdout.output.slice(suspendedOutput.length).includes("Text only"), "Static transcript repaints");
  await app.input("\r");
  assert.deepEqual(connector.sent, [], "Dismissal key cannot enter the composer");
});

test("App rejects removed preview arguments without capture", async (t) => {
  const connector = new PreviewConnector(async () => ({ images: [] }));
  const app = await mount(t, "WezTerm", connector);
  for (const argument of ["select", "latest", "0"]) {
    await app.input(`/preview ${argument}\r`);
    await until(() => app.stdout.output.includes("Usage: /preview"), "Usage notice appears");
  }
  assert.equal(connector.captures, 0);
  assert.deepEqual(connector.sent, []);
});

for (const [result, notice] of [
  [{ images: [] }, "No visible images to preview."],
  [{ unavailable: "permission-denied" }, "Image capture permission is missing."],
  [{ unavailable: "connector-unsupported" }, "This connector does not support image previews."],
  [{ unavailable: "capture-failed" }, "Could not capture the image."],
] as const) {
  test(`App gallery reports ${notice}`, async (t) => {
    const connector = new PreviewConnector(async () => ({ ...result } as ImageGalleryResult));
    const app = await mount(t, "ghostty", connector);
    await app.input("/preview\r");
    await until(() => app.stdout.output.includes(notice), "Failure or empty notice appears");
    assert.equal(connector.captures, 1);
    assert.ok(!app.stdout.output.includes("\x1b_Ga=T"));
    assert.deepEqual(connector.sent, []);
  });
}

test("App cleans every crop and resumes after a gallery read failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const images = [1, 2, 3].map((i) => ({ path: join(directory, `capture-${i}.png`), width: 1, height: 1 }));
  const connector = new PreviewConnector(async () => {
    await writeFile(images[0]!.path, png);
    await writeFile(images[2]!.path, png);
    return { images };
  });
  const app = await mount(t, "ghostty", connector);
  await app.input("/preview\r");
  await until(() => app.stdout.output.includes("Could not capture the image."), "Gallery failure resumes Ink");
  for (const image of images) await assert.rejects(access(image.path), { code: "ENOENT" });
  assert.ok(app.stdout.output.includes("\x1b_Ga=d,d=I"));
  await app.input("/preview select\r");
  await until(() => app.stdout.output.includes("Usage: /preview"), "Normal commands still work");
  assert.deepEqual(connector.sent, []);
});

test("App unmount aborts a waiting gallery and deletes its crops", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  const connector = new PreviewConnector(async () => {
    await writeFile(path, png);
    return { images: [{ path, width: 1, height: 1 }] };
  });
  const app = await mount(t, "ghostty", connector);
  await app.input("/preview\r");
  await until(() => app.stdout.output.includes("Press Esc/q"), "Gallery appears");
  app.instance.unmount();
  await app.instance.waitUntilExit();
  await delay(40);
  await assert.rejects(access(path), { code: "ENOENT" });
  assert.equal(app.stdin.listenerCount("readable"), 0);
});
