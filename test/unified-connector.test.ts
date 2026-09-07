import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { ChatConnector, ChatSnapshot } from "../src/domain.js";
import { UnifiedChatConnector } from "../src/connectors/unified.js";

class FakeConnector extends EventEmitter implements ChatConnector {
  public sent: string[] = [];
  public conversationLoads = 0;

  public constructor(private snapshot: ChatSnapshot) {
    super();
  }

  public getSnapshot(): ChatSnapshot {
    return this.snapshot;
  }

  public async start(): Promise<void> {
    this.emit("snapshot", this.snapshot);
  }

  public async stop(): Promise<void> {}

  public async refresh(): Promise<void> {
    this.emit("snapshot", this.snapshot);
  }

  public async openConversation(id: string): Promise<void> {
    this.snapshot = { ...this.snapshot, activeConversationId: id };
    this.emit("snapshot", this.snapshot);
  }

  public async sendMessage(text: string): Promise<void> {
    this.sent.push(text);
  }

  public async loadOlderMessages(): Promise<number> {
    return 3;
  }

  public async loadMoreConversations(): Promise<number> {
    this.conversationLoads += 1;
    return 4;
  }
}

class FileCapableConnector extends FakeConnector {
  public sentFiles: string[][] = [];
  public async sendFile(paths: string[]): Promise<void> {
    this.sentFiles.push(paths);
  }
}

test("sendFile은 활성 provider가 지원할 때만 파일을 전달한다", async () => {
  const instagram = new FakeConnector({
    state: "connected",
    conversations: [{ id: "c", href: "/direct/t/c", title: "Instagram", unread: false }],
    messages: [],
  });
  const kakao = new FileCapableConnector({
    state: "connected",
    conversations: [{ id: "c", href: "kakaotalk:1", title: "KakaoTalk", unread: false }],
    messages: [],
  });
  const connector = new UnifiedChatConnector([
    { id: "instagram", label: "Instagram", connector: instagram },
    { id: "kakaotalk", label: "KakaoTalk", connector: kakao },
  ]);
  await connector.start();

  await connector.openConversation("kakaotalk:c");
  await connector.sendFile(["/tmp/a.png"]);
  assert.deepEqual(kakao.sentFiles, [["/tmp/a.png"]]);

  await connector.openConversation("instagram:c");
  await assert.rejects(() => connector.sendFile(["/tmp/a.png"]), /파일 전송을 지원하지 않습니다/);
});

test("여러 connector의 대화방 id를 구분하고 선택한 provider로 전송한다", async () => {
  const instagram = new FakeConnector({
    state: "connected",
    conversations: [{ id: "same", href: "/direct/t/same", title: "Instagram", unread: false }],
    messages: [],
  });
  const kakao = new FakeConnector({
    state: "connected",
    conversations: [{ id: "same", href: "kakaotalk:1", title: "KakaoTalk", unread: true }],
    messages: [],
  });
  const connector = new UnifiedChatConnector([
    { id: "instagram", label: "Instagram", connector: instagram },
    { id: "kakaotalk", label: "KakaoTalk", connector: kakao },
  ]);

  await connector.start();
  assert.deepEqual(
    connector.getSnapshot().conversations.map(({ id, provider }) => ({ id, provider })),
    [
      { id: "instagram:same", provider: "instagram" },
      { id: "kakaotalk:same", provider: "kakaotalk" },
    ],
  );

  await connector.openConversation("kakaotalk:same");
  await connector.sendMessage("테스트");

  assert.equal(connector.getSnapshot().activeConversationId, "kakaotalk:same");
  assert.deepEqual(kakao.sent, ["테스트"]);
  assert.deepEqual(instagram.sent, []);
  assert.equal(await connector.loadOlderMessages(), 3);
  assert.equal(await connector.loadMoreConversations("instagram"), 4);
  assert.equal(instagram.conversationLoads, 1);
  assert.equal(kakao.conversationLoads, 0);
});
