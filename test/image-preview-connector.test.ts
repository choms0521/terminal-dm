import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatConnector, ChatSnapshot, ImageGalleryResult } from "../src/domain.js";
import { KakaoNativeConnector } from "../src/connectors/kakao-native.js";
import { UnifiedChatConnector } from "../src/connectors/unified.js";

const snapshot: ChatSnapshot = {
  state: "connected", conversations: [], activeConversationId: "room",
  messages: [{ id: "photo", threadId: "room", sender: "sender", text: "photo", kind: "image" }],
};
function native(request: (action: string, payload: Record<string, unknown>) => Promise<ImageGalleryResult>) {
  const connector = new KakaoNativeConnector();
  Object.assign(connector, { activeTitle: "room", activeConversationId: "room", snapshot, actionBridge: { request, stop: async () => {} }, readBridge: { stop: async () => {} } });
  return connector;
}

test("native gallery RPC requests all visible images using only the active title", async () => {
  const calls: unknown[] = [];
  const connector = native(async (action, payload) => {
    calls.push({ action, payload });
    return { images: [] };
  });
  assert.deepEqual(await connector.previewImages(), { images: [] });
  assert.deepEqual(calls, [
    { action: "captureVisibleImages", payload: { title: "room" } },
  ]);
});

test("native gallery requires an active conversation and running connector", async () => {
  assert.deepEqual(await new KakaoNativeConnector().previewImages(), { unavailable: "no-conversation" });
  const connector = native(async () => { throw new Error("must not run"); });
  await connector.stop();
  assert.deepEqual(await connector.previewImages(), { unavailable: "not-visible" });
});

test("native preview converts bridge rejection to an unavailable notice and releases busy state", async () => {
  let calls = 0;
  const connector = native(async () => { calls += 1; throw new Error("bridge unavailable"); });
  assert.deepEqual(await connector.previewImages(), { unavailable: "capture-failed" });
  assert.deepEqual(await connector.previewImages(), { unavailable: "capture-failed" });
  assert.equal(calls, 2);
});

test("native preview serializes capture requests and returns successful temp ownership to consumer", async () => {
  let resolve!: (result: ImageGalleryResult) => void;
  const connector = native(async () => new Promise((done) => { resolve = done; }));
  const pending = connector.previewImages();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(await connector.previewImages(), { unavailable: "busy" });
  const result = { images: [{ path: "/tmp/fake-preview.png", width: 424, height: 264 }] };
  resolve(result);
  assert.deepEqual(await pending, result);
});

test("shutdown waits for capture and deletes all gallery PNGs instead of abandoning them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-stop-"));
  const paths = [join(directory, "photo.png"), join(directory, "sticker.png")];
  try {
    await Promise.all(paths.map((path) => writeFile(path, "temporary fixture")));
    let resolve!: (result: ImageGalleryResult) => void;
    const connector = native(async () => new Promise((done) => { resolve = done; }));
    const pending = connector.previewImages();
    await new Promise((done) => setImmediate(done));
    const stopping = connector.stop();
    resolve({ images: paths.map((path) => ({ path, width: 1, height: 1 })) });
    assert.deepEqual(await pending, { unavailable: "not-visible" });
    await stopping;
    for (const path of paths) await assert.rejects(access(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a gallery captured for a conversation that changed is disposed before returning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-change-"));
  const path = join(directory, "photo.png");
  try {
    await writeFile(path, "temporary fixture");
    let resolve!: (result: ImageGalleryResult) => void;
    const connector = native(async () => new Promise((done) => { resolve = done; }));
    const pending = connector.previewImages();
    await new Promise((done) => setImmediate(done));
    Object.assign(connector, { activeTitle: "another room" });
    resolve({ images: [{ path, width: 1, height: 1 }] });
    assert.deepEqual(await pending, { unavailable: "not-visible" });
    await assert.rejects(access(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("shutdown during an existing read prevents the gallery RPC from starting", async () => {
  const connector = native(async () => { throw new Error("must not run"); });
  let finishRead!: () => void;
  Object.assign(connector, {
    refreshPromise: new Promise<void>((resolve) => { finishRead = resolve; }),
    readBridge: { stop: async () => { finishRead(); } },
  });
  const pending = connector.previewImages();
  const stopping = connector.stop();
  assert.deepEqual(await pending, { unavailable: "not-visible" });
  await stopping;
});

class FakeConnector extends EventEmitter implements ChatConnector {
  getSnapshot(): ChatSnapshot { return snapshot; }
  async start() {}
  async stop() {}
  async refresh() {}
  async openConversation(_id: string) {}
  async sendMessage(_text: string) {}
  async loadMoreConversations() { return 0; }
  async loadOlderMessages() { return 0; }
}
class PreviewConnector extends FakeConnector {
  captures = 0;
  async previewImages(): Promise<ImageGalleryResult> {
    this.captures += 1;
    return { unavailable: "permission-denied" };
  }
}

test("unified preview delegates only to the active provider and handles absent capability", async () => {
  const kakao = new PreviewConnector();
  const unified = new UnifiedChatConnector([
    { id: "kakaotalk", label: "KakaoTalk", connector: kakao },
    { id: "instagram", label: "Instagram", connector: new FakeConnector() },
  ]);
  await assert.rejects(unified.previewImages());
  await unified.openConversation("kakaotalk:room");
  assert.deepEqual(await unified.previewImages(), { unavailable: "permission-denied" });
  await unified.previewImages();
  await unified.openConversation("instagram:room");
  assert.deepEqual(await unified.previewImages(), { unavailable: "connector-unsupported" });
  assert.equal(kakao.captures, 2);
});
