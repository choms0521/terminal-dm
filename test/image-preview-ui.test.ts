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

import type { ChatConnector, ChatSnapshot, ImagePreviewResult, ImagePreviewSelector } from "../src/domain.js";
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
  readonly captures: ImagePreviewSelector[] = [];
  readonly sent: string[] = [];
  readonly snapshot: ChatSnapshot = {
    state: "connected",
    activeConversationId: "room",
    conversations: [{ id: "room", provider: "kakaotalk", title: "Preview room", href: "kakaotalk:room", unread: false }],
    messages: [
      { id: "old-photo", threadId: "room", sender: "Peer", kind: "image", text: "", previewIndex: 2 },
      { id: "text", threadId: "room", sender: "Peer", kind: "text", text: "Text only" },
      { id: "sticker", threadId: "room", sender: "Peer", kind: "sticker", text: "", previewIndex: 1 },
      { id: "new-photo", threadId: "room", sender: "Peer", kind: "image", text: "", previewIndex: 0 },
    ],
  };

  constructor(private readonly capture: () => Promise<ImagePreviewResult>) { super(); }
  getSnapshot(): ChatSnapshot { return this.snapshot; }
  async start(): Promise<void> { this.emit("snapshot", this.snapshot); }
  async stop(): Promise<void> {}
  async refresh(): Promise<void> {}
  async loadMoreConversations(): Promise<number> { return 0; }
  async loadOlderMessages(): Promise<number> { return 0; }
  async openConversation(): Promise<void> {}
  async sendMessage(text: string): Promise<void> { this.sent.push(text); }
  async previewImage(selector: ImagePreviewSelector): Promise<ImagePreviewResult> {
    this.captures.push(selector);
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
  assert.deepEqual(connector.captures, []);
  assert.deepEqual(connector.sent, []);
  assert.ok(!app.stdout.output.includes("\x1b_G"));
});

test("App selection arrows and Enter capture the selected sticker and restore primary screen before graphics", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "capture.png");
  const connector = new PreviewConnector(async () => {
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4N8AAAAASUVORK5CYII=", "base64"));
    return { path, width: 1, height: 1 };
  });
  const app = await mount(t, "ghostty", connector);
  await app.input("/preview select\r");
  await until(() => app.stdout.output.includes("select message"), "Selection mode appears");
  await app.input("\x1b[A");
  await app.input("\x1b[A");
  await app.input("\x1b[B");
  await app.input("\r");
  await until(() => app.stdout.output.includes("Image shown."), "Preview succeeds");
  assert.deepEqual(connector.captures, [1]);
  assert.deepEqual(connector.sent, []);
  await assert.rejects(access(path), { code: "ENOENT" });
  const enterAlternate = app.stdout.output.indexOf("\x1b[?1049h");
  const leaveAlternate = app.stdout.output.indexOf("\x1b[?1049l", enterAlternate);
  const graphics = app.stdout.output.indexOf("\x1b_G");
  assert.ok(enterAlternate >= 0 && leaveAlternate > enterAlternate && graphics > leaveAlternate);
  assert.match(app.stdout.output.slice(graphics), /^\x1b_Ga=T,f=100,t=d,q=2,C=1,c=40,r=20,m=0;/);
});

test("App selected text produces a notice and does not capture or send", async (t) => {
  const connector = new PreviewConnector(async () => ({ unavailable: "no-image" }));
  const app = await mount(t, "WezTerm", connector);
  await app.input("/preview select\r");
  await until(() => app.stdout.output.includes("select message"), "Selection mode appears");
  await app.input("\x1b[A");
  await app.input("\x1b[A");
  await app.input("\r");
  await until(() => app.stdout.output.includes("Select a photo or sticker message."), "Text selection notice is shown");
  assert.deepEqual(connector.captures, []);
  assert.deepEqual(connector.sent, []);
});
