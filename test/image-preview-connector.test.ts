import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatConnector, ChatSnapshot, ImagePreviewResult, ImagePreviewSelector } from "../src/domain.js";
import { KakaoNativeConnector } from "../src/connectors/kakao-native.js";
import { UnifiedChatConnector } from "../src/connectors/unified.js";

const snapshot: ChatSnapshot = {
  state: "connected", conversations: [], activeConversationId: "room",
  messages: [{ id: "photo", threadId: "room", sender: "sender", text: "photo", kind: "image", previewIndex: 4, previewImageCount: 9 }],
};
function native(request: (action: string, payload: Record<string, unknown>) => Promise<ImagePreviewResult>) {
  const connector = new KakaoNativeConnector();
  Object.assign(connector, { activeTitle: "room", activeConversationId: "room", snapshot, actionBridge: { request, stop: async () => {} }, readBridge: { stop: async () => {} } });
  return connector;
}

test("native preview RPC forwards latest and exact selected native index with count guard", async () => {
  const calls: unknown[] = [];
  const connector = native(async (action, payload) => {
    calls.push({ action, payload });
    return { unavailable: "no-image" };
  });
  assert.deepEqual(await connector.previewImage("latest"), { unavailable: "no-image" });
  await connector.previewImage(4);
  assert.deepEqual(calls, [
    { action: "captureMessageImage", payload: { title: "room", selector: "latest" } },
    { action: "captureMessageImage", payload: { title: "room", selector: 4, expectedImageCount: 9 } },
  ]);
});

test("native preview rejects invalid or unmapped selectors without invoking the bridge", async () => {
  const connector = native(async () => { throw new Error("must not run"); });
  assert.deepEqual(await connector.previewImage(-1), { unavailable: "invalid-selector" });
  assert.deepEqual(await connector.previewImage(0.5), { unavailable: "invalid-selector" });
  assert.deepEqual(await connector.previewImage(NaN), { unavailable: "invalid-selector" });
  assert.deepEqual(await connector.previewImage(0), { unavailable: "not-visible" });
  assert.deepEqual(await new KakaoNativeConnector().previewImage("latest"), { unavailable: "no-conversation" });
});

test("native preview converts bridge rejection to an unavailable notice and releases busy state", async () => {
  let calls = 0;
  const connector = native(async () => { calls += 1; throw new Error("bridge unavailable"); });
  assert.deepEqual(await connector.previewImage("latest"), { unavailable: "capture-failed" });
  assert.deepEqual(await connector.previewImage("latest"), { unavailable: "capture-failed" });
  assert.equal(calls, 2);
});

test("native preview serializes capture requests and returns successful temp ownership to consumer", async () => {
  let resolve!: (result: ImagePreviewResult) => void;
  const connector = native(async () => new Promise((done) => { resolve = done; }));
  const pending = connector.previewImage("latest");
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(await connector.previewImage("latest"), { unavailable: "busy" });
  const result = { path: "/tmp/fake-preview.png", width: 424, height: 264 };
  resolve(result);
  assert.deepEqual(await pending, result);
});

test("shutdown waits for capture and deletes its PNG instead of abandoning it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tdm-preview-stop-"));
  const path = join(directory, "image.png");
  try {
    await writeFile(path, "temporary fixture");
    let resolve!: (result: ImagePreviewResult) => void;
    const connector = native(async () => new Promise((done) => { resolve = done; }));
    const pending = connector.previewImage("latest");
    await new Promise((done) => setImmediate(done));
    const stopping = connector.stop();
    resolve({ path, width: 1, height: 1 });
    assert.deepEqual(await pending, { unavailable: "not-visible" });
    await stopping;
    await assert.rejects(access(path), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
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
  selectors: ImagePreviewSelector[] = [];
  async previewImage(selector: ImagePreviewSelector): Promise<ImagePreviewResult> {
    this.selectors.push(selector);
    return { unavailable: "permission-denied" };
  }
}

test("unified preview delegates only to the active provider and handles absent capability", async () => {
  const kakao = new PreviewConnector();
  const unified = new UnifiedChatConnector([
    { id: "kakaotalk", label: "KakaoTalk", connector: kakao },
    { id: "instagram", label: "Instagram", connector: new FakeConnector() },
  ]);
  await assert.rejects(unified.previewImage("latest"));
  await unified.openConversation("kakaotalk:room");
  assert.deepEqual(await unified.previewImage(4), { unavailable: "permission-denied" });
  await unified.previewImage("latest");
  await unified.openConversation("instagram:room");
  assert.deepEqual(await unified.previewImage("latest"), { unavailable: "connector-unsupported" });
  assert.deepEqual(kakao.selectors, [4, "latest"]);
});
