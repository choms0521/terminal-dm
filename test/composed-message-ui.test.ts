import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { render } from "ink";
import { createElement } from "react";

import type { ChatConnector, ChatSnapshot } from "../src/domain.js";
import { App } from "../src/ui/app.js";

type Send = { kind: "text"; text: string } | { kind: "files"; paths: string[] };

class MemoryOutput extends Writable {
  isTTY = true;
  columns = 120;
  rows = 36;
  output = "";

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.output += chunk.toString();
    callback();
  }
}

class ComposedConnector extends EventEmitter implements ChatConnector {
  readonly sent: Send[] = [];
  sendFile?: (paths: string[]) => Promise<void>;
  readonly snapshot: ChatSnapshot = {
    state: "connected",
    activeConversationId: "room",
    conversations: [{ id: "room", provider: "kakaotalk", title: "Composer room", href: "kakaotalk:room", unread: false }],
    messages: [],
  };

  constructor(private readonly afterSend: (send: Send) => Promise<void> = async () => {}, supportsFiles = true) {
    super();
    if (supportsFiles) this.sendFile = (paths) => this.record({ kind: "files", paths });
  }
  getSnapshot(): ChatSnapshot { return this.snapshot; }
  async start(): Promise<void> { this.emit("snapshot", this.snapshot); }
  async stop(): Promise<void> {}
  async refresh(): Promise<void> {}
  async loadMoreConversations(): Promise<number> { return 0; }
  async loadOlderMessages(): Promise<number> { return 0; }
  async openConversation(): Promise<void> {}
  async sendMessage(text: string): Promise<void> { await this.record({ kind: "text", text }); }
  private async record(send: Send): Promise<void> {
    this.sent.push(send);
    await this.afterSend(send);
  }
}

async function until(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await delay(10);
  assert.ok(condition(), description);
}

async function fixture(t: TestContext, connector = new ComposedConnector()) {
  const directory = await mkdtemp(join(tmpdir(), "tdm-composed-ui-"));
  const paths = [join(directory, "first.png"), join(directory, "second.png")];
  await Promise.all(paths.map((path) => writeFile(path, "fake image")));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
  });
  await until(() => stdout.output.includes("Type your message..."), "Composer is ready");
  await delay(20);
  return {
    paths, connector, stdout,
    async submit(value: string) {
      stdin.write(`${value}\r`);
      await delay(40);
      await instance.waitUntilRenderFlush();
    },
  };
}

for (const fileCount of [1, 2]) {
  test(`App awaits each mixed segment and groups ${fileCount} consecutive file(s)`, async (t) => {
    const releases: Array<() => void> = [];
    const connector = new ComposedConnector(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    t.after(() => releases.forEach((release) => release()));
    const app = await fixture(t, connector);
    const paths = app.paths.slice(0, fileCount);
    await app.submit(`hello ${paths.join(" ")} look here`);
    assert.deepEqual(connector.sent, [{ kind: "text", text: "hello" }]);
    assert.ok(app.stdout.output.includes("Sending message and images…"));
    releases[0]!();
    await until(() => connector.sent.length === 2, "File send begins after text resolves");
    await delay(40);
    assert.deepEqual(connector.sent, [{ kind: "text", text: "hello" }, { kind: "files", paths }]);
    releases[1]!();
    await until(() => connector.sent.length === 3, "Trailing text begins after files resolve");
    assert.deepEqual(connector.sent[2], { kind: "text", text: "look here" });
    releases[2]!();
  });
}

test("App sends absolute-file-first mixed input instead of treating it as a command", async (t) => {
  const app = await fixture(t);
  await app.submit(`${app.paths[0]} caption`);
  assert.deepEqual(app.connector.sent, [
    { kind: "files", paths: [app.paths[0]!] },
    { kind: "text", text: "caption" },
  ]);
});

test("App keeps pure text spacing and quotes and honors the literal slash override", async (t) => {
  const app = await fixture(t);
  await app.submit('hello  "quoted words"  world');
  await app.submit(`//literal ${app.paths[0]}  text`);
  assert.deepEqual(app.connector.sent, [
    { kind: "text", text: 'hello  "quoted words"  world' },
    { kind: "text", text: `/literal ${app.paths[0]}  text` },
  ]);
});

test("App preserves drag-to-send, /file, and /help routing", async (t) => {
  const app = await fixture(t);
  await app.submit(app.paths.join(" "));
  await app.submit(`/file ${app.paths[0]}`);
  await app.submit(`/help ${app.paths[0]}`);
  assert.deepEqual(app.connector.sent, [
    { kind: "files", paths: app.paths },
    { kind: "files", paths: [app.paths[0]!] },
  ]);
});

for (const state of ["no conversation", "cleared workspace", "unsupported files"] as const) {
  test(`App rejects mixed sends before sending text with ${state}`, async (t) => {
    const connector = new ComposedConnector(undefined, state !== "unsupported files");
    if (state === "no conversation") delete connector.snapshot.activeConversationId;
    const app = await fixture(t, connector);
    if (state === "cleared workspace") await app.submit("/clear");
    await app.submit(`hello ${app.paths[0]} goodbye`);
    assert.deepEqual(connector.sent, []);
    if (state === "unsupported files") {
      assert.ok(app.stdout.output.includes("파일 전송을 지원하지 않습니다."));
    }
  });
}

test("App stops a mixed sequence after a failed file send", async (t) => {
  const connector = new ComposedConnector(async (send) => {
    if (send.kind === "files") throw new Error("File send failed for test");
  });
  const app = await fixture(t, connector);
  await app.submit(`hello ${app.paths[0]} must not send`);
  assert.deepEqual(connector.sent, [
    { kind: "text", text: "hello" },
    { kind: "files", paths: [app.paths[0]!] },
  ]);
  assert.ok(app.stdout.output.includes("File send failed for test"));
});
