import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chromium } from "playwright-core";

import {
  canonicalizeInstagramSenders,
  cloneInstagramProfile,
  clickInstagramConversationRow,
  inheritInstagramRawSenders,
  InstagramWebConnector,
  isTransientInstagramNavigationError,
  isInstagramProfileLockError,
  observeInstagramChanges,
  readInstagramDirectThreadIdentity,
  readInstagramMessageRows,
} from "../src/connectors/instagram-web.js";

test("동시 실행용 Instagram 프로필 복제에서는 Chromium lock을 제외한다", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-dm-profile-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(path.join(source, "Default"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(source, "Default", "Cookies"), "session"),
    fs.writeFile(path.join(source, "Local State"), "state"),
    fs.writeFile(path.join(source, "SingletonLock"), "locked"),
  ]);

  const clone = await cloneInstagramProfile(source, root);
  assert.equal(await fs.readFile(path.join(clone.profileDir, "Default", "Cookies"), "utf8"), "session");
  assert.equal(await fs.readFile(path.join(clone.profileDir, "Local State"), "utf8"), "state");
  await assert.rejects(fs.lstat(path.join(clone.profileDir, "SingletonLock")), { code: "ENOENT" });
});

test("Chromium profile 중복 실행 오류를 식별한다", () => {
  assert.equal(isInstagramProfileLockError(new Error("Failed to create a ProcessSingleton")), true);
  assert.equal(isInstagramProfileLockError(new Error("profile appears to be in use")), true);
  assert.equal(isInstagramProfileLockError(new Error("browser executable is missing")), false);
});

test("1:1 대화 헤더의 프로필 링크에서 표시 이름과 계정 ID를 연결한다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  await page.setContent(`
    <main>
      <a href="/wo.ghks2/" style="display:block;width:160px;height:44px">
        <h2>재환님</h2><span>wo.ghks2</span>
      </a>
    </main>
  `);

  const identity = await page.locator("main").evaluate(readInstagramDirectThreadIdentity);
  assert.deepEqual(identity, { displayName: "재환", username: "wo.ghks2" });
});

test("그룹 대화 제목은 참여자 별칭으로 사용하지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  await page.setContent(`
    <main>
      <div role="button" style="width:220px;height:44px"><h2>12.24 민주화폭동</h2></div>
      <a href="/member_one/" style="display:none"><h2>멤버 한 명</h2></a>
    </main>
  `);

  const identity = await page.locator("main").evaluate(readInstagramDirectThreadIdentity);
  assert.equal(identity, null);
});

test("답장 다음의 이름 없는 일반 메시지에는 답장 대상을 상속하지 않는다", () => {
  const messages = inheritInstagramRawSenders([
    { text: "택시비 시팣", sender: "polalmkhksohn_", senderSource: "display" },
    {
      text: "아니지",
      sender: "polalmkhksohn_ replied to 임규현",
      ariaLabel: "polalmkhksohn_ replied to 임규현",
      senderSource: "display",
    },
    { text: "아니지", sender: null },
    { text: "담배걸린거아니다", sender: null },
  ]);

  assert.deepEqual(messages.map((message) => ({
    sender: message.sender,
    ariaLabel: message.ariaLabel,
  })), [
    { sender: "polalmkhksohn_", ariaLabel: undefined },
    {
      sender: "polalmkhksohn_ replied to 임규현",
      ariaLabel: "polalmkhksohn_ replied to 임규현",
    },
    { sender: "polalmkhksohn_", ariaLabel: undefined },
    { sender: "polalmkhksohn_", ariaLabel: undefined },
  ]);
});

test("연속된 왼쪽 버블의 마지막 프로필 이름을 앞선 unlabeled 버블에 적용한다", () => {
  const messages = inheritInstagramRawSenders([
    {
      text: "내일 정리 끝내면 언제가 될진 모르겠는데",
      sender: "unknown",
      visualTop: 171,
      visualBottom: 211,
      visualLeft: 486,
    },
    {
      text: "시간되면 감",
      sender: "wo.ghks2",
      senderSource: "profile",
      senderIdentity: "wo.ghks2",
      visualTop: 213,
      visualBottom: 253,
      visualLeft: 486,
    },
  ]);

  assert.equal(messages[0]?.sender, "wo.ghks2");
  assert.equal(messages[0]?.senderInferred, true);
  assert.equal(messages[0]?.senderIdentity, "wo.ghks2");
});

test("멀리 떨어지거나 정렬이 다른 다음 버블의 이름은 거꾸로 상속하지 않는다", () => {
  const messages = inheritInstagramRawSenders([
    {
      text: "이름 없는 메시지",
      sender: "unknown",
      visualTop: 100,
      visualBottom: 136,
      visualLeft: 486,
    },
    {
      text: "다른 메시지",
      sender: "someone_else",
      visualTop: 170,
      visualBottom: 206,
      visualLeft: 520,
    },
  ]);

  assert.equal(messages[0]?.sender, "unknown");
});

test("프로필 ID를 같은 사람의 표시 이름으로 대화방 전체에서 통일한다", () => {
  const aliases = new Map<string, string>();
  const currentWindow = canonicalizeInstagramSenders([
    {
      text: "ㅈ박은줄 알았는데",
      sender: "故추whw만함",
      senderSource: "display",
      senderIdentity: "zxngw0o님의 프로필 사진",
    },
    {
      text: "국민대 가고싶습니다",
      sender: "zxngw0o님의 프로필 사진",
      senderSource: "profile",
    },
  ], aliases);

  assert.equal(aliases.get("zxngw0o"), "故추whw만함");
  assert.deepEqual(currentWindow.map((message) => message.sender), [
    "故추whw만함",
    "故추whw만함",
  ]);

  const olderWindow = canonicalizeInstagramSenders([
    {
      text: "여자 얼굴보고 욕하겟냐고",
      sender: "zxngw0o님의 프로필 사진",
      senderSource: "profile",
    },
  ], aliases);
  assert.equal(olderWindow[0]?.sender, "故추whw만함");
});

test("표시 이름이 첫 bubble에 있고 프로필 ID가 마지막 bubble에 있어도 같은 발신자로 묶는다", () => {
  const aliases = new Map<string, string>();
  const messages = canonicalizeInstagramSenders([
    {
      text: "아이 내가 국민대를 갔는데",
      sender: "故추whw만함",
      senderSource: "display",
    },
    {
      text: "여자 얼굴보고 욕하겟냐고 ㅅㅂ",
      sender: "Open the profile page of zxngw0o",
      senderSource: "profile",
      senderIdentity: "zxngw0o",
    },
    {
      text: "할것 같은데",
      sender: "이정민",
      senderSource: "display",
    },
  ], aliases);

  assert.equal(aliases.get("zxngw0o"), "故추whw만함");
  assert.deepEqual(messages.map((message) => message.sender), [
    "故추whw만함",
    "故추whw만함",
    "이정민",
  ]);
});

test("표시 이름과 계정 ID가 달라도 같은 프로필 링크를 기준으로 통일한다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div class="message-group">
          <div>故추whw만함</div>
          <div role="row">
            <img alt="故추whw만함님의 프로필 사진" />
            <span>아이 내가 국민대를 갔는데</span>
          </div>
          <a href="/zxngw0o/">프로필 열기</a>
        </div>
        <div class="message-group">
          <div role="row">
            <a href="/zxngw0o/"><img alt="zxngw0o님의 프로필 사진" /></a>
            <span>여자 얼굴보고 욕하겟냐고 ㅅㅂ</span>
          </div>
        </div>
      </section>
    </main>
  `);

  const raw = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);
  assert.deepEqual(raw.map((message) => message.senderIdentity), ["zxngw0o", "zxngw0o"]);

  const aliases = new Map<string, string>();
  const messages = canonicalizeInstagramSenders(raw, aliases);
  assert.equal(aliases.get("zxngw0o"), "故추whw만함");
  assert.deepEqual(messages.map((message) => message.sender), [
    "故추whw만함",
    "故추whw만함",
  ]);
});

test("tsx로 실행해도 Instagram evaluateAll 콜백이 브라우저에서 독립적으로 동작한다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <nav role="navigation">
        <div role="button" style="width: 400px; height: 60px">
          <span>김태현님</span><span>첫 번째 대화</span>
        </div>
        <div role="button" style="width: 400px; height: 60px">
          <span>김태현님</span><span>두 번째 대화</span>
        </div>
      </nav>
    </main>
  `);
  const rows = page.locator('main [role="navigation"] [role="button"]');
  await rows.nth(0).evaluate((element) => {
    Object.defineProperty(element, "__reactFiber$test", {
      value: { memoizedProps: { threadKeyForSelection: "111" } },
      enumerable: true,
    });
  });
  await rows.nth(1).evaluate((element) => {
    Object.defineProperty(element, "__reactFiber$test", {
      value: { memoizedProps: { threadKeyForSelection: "222" } },
      enumerable: true,
    });
    element.addEventListener("click", () => element.setAttribute("data-clicked", "true"));
  });

  await rows.evaluateAll(clickInstagramConversationRow, {
    index: 0,
    title: "김태현님",
    identity: "thread:222",
  });

  assert.equal(await rows.nth(0).getAttribute("data-clicked"), null);
  assert.equal(await rows.nth(1).getAttribute("data-clicked"), "true");
});

test("대화 제목이 현재 가상화 창에 없으면 다른 위치의 행을 대신 클릭하지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main><nav role="navigation">
      <div role="button" style="width:400px;height:60px"><span>태희님</span><span>좋다</span></div>
    </nav></main>
  `);
  const row = page.locator('main [role="navigation"] [role="button"]');
  await row.evaluate((element) => {
    element.addEventListener("click", () => element.setAttribute("data-clicked", "true"));
  });

  await assert.rejects(
    page.locator('main [role="navigation"] [role="button"]').evaluateAll(
      clickInstagramConversationRow,
      { index: 0, title: "12.24 민주화폭동" },
    ),
    /대화 행을 찾지 못했습니다/,
  );
  assert.equal(await row.getAttribute("data-clicked"), null);
});

test("안정적인 thread identity가 있으면 가상화된 행 대신 정확한 URL을 연다", async () => {
  const connector = new InstagramWebConnector({ profileDir: "/tmp/unused-profile" });
  const visited: string[] = [];
  const internal = connector as unknown as {
    page: {
      url: () => string;
      goto: (url: string) => Promise<void>;
      waitForTimeout: () => Promise<void>;
    };
    snapshot: {
      state: "connected";
      conversations: Array<{
        id: string;
        href: string;
        identity: string;
        title: string;
        unread: boolean;
      }>;
      messages: [];
    };
    readVisibleMessages: () => Promise<Array<{ id: string }>>;
    refreshAfterConversationOpen: () => Promise<void>;
  };
  internal.page = {
    url: () => "https://www.instagram.com/direct/t/old-thread/",
    goto: async (url) => { visited.push(url); },
    waitForTimeout: async () => undefined,
  };
  internal.snapshot = {
    state: "connected",
    conversations: [{
      id: "button-thread:target",
      href: "button:0",
      identity: "thread:7019441201435662",
      title: "12.24 민주화폭동",
      unread: false,
    }],
    messages: [],
  };
  internal.readVisibleMessages = async () => [{ id: "ready" }];
  internal.refreshAfterConversationOpen = async () => undefined;

  await connector.openConversation("button-thread:target");
  assert.deepEqual(visited, ["https://www.instagram.com/direct/t/7019441201435662/"]);
});

test("tsx로 실행해도 Instagram init script가 DOM 변경을 감지한다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(observeInstagramChanges);
  await page.goto("data:text/html,<main></main>");
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __terminalDmWake?: () => void;
      __wakeCount?: number;
    };
    browserWindow.__wakeCount = 0;
    browserWindow.__terminalDmWake = () => {
      browserWindow.__wakeCount = (browserWindow.__wakeCount ?? 0) + 1;
    };
    document.querySelector("main")?.setAttribute("aria-live", "polite");
  });

  await page.waitForFunction(() => (
    (window as typeof window & { __wakeCount?: number }).__wakeCount ?? 0
  ) > 0);
});

test("Instagram 인라인 공유는 작성자 ID를 제목으로 쓰지 않고 릴스로 표시한다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <iframe src="data:text/html,cross-origin-frame"></iframe>
      <section>
        <div>故추whw만함</div>
        <div role="row">
          <img alt="zxngw0o님의 프로필 사진" />
          <div class="media-card"><a href="/boseok_i/">boseok_i</a></div>
        </div>
      </section>
      <section>
        <div>박가은</div>
        <div role="row"><a href="/reel/ABC123/" aria-label="축구 끝나고 집 가는 길">author_id</a></div>
      </section>
      <section>
        <div>임규현</div>
        <div role="row" class="normal-message"><span>일반 메시지</span></div>
      </section>
      <section>
        <div>서정현</div>
        <div role="row" class="post-card"><a href="/post_author/">post_author</a></div>
      </section>
      <section>
        <div>박가은</div>
        <div role="row" class="photo-message"><img alt="Photo" /></div>
      </section>
      <section>
        <div>hyeon_0627</div>
        <div role="row" class="reply-message" aria-label="polalmkhksohn_ replied to hyeon_0627">
          <span>집갔는데 문잠겨있다 이제</span>
        </div>
      </section>
    </main>
  `);
  await page.locator(".media-card").evaluate((element) => {
    Object.defineProperty(element, "__reactFiber$test", {
      enumerable: true,
      value: {
        memoizedProps: {
          embeddedWindow: document.querySelector("iframe")?.contentWindow,
          slideMessageRef: { content_type: "MESSAGE_INLINE_SHARE" },
        },
        child: {
          sibling: {
            child: {
              memoizedProps: {
                headerTitle: "boseok_i",
                targetUrl: "https://www.instagram.com/p/DcyUcaniV-t/?carousel_share_child_media_id=3977331270096415912_5756598919&is_ineligible_for_clips_chaining=false",
              },
            },
          },
        },
      },
    });
  });
  await page.locator(".normal-message").evaluate((element) => {
    Object.defineProperty(element, "__reactFiber$test", {
      enumerable: true,
      value: {
        memoizedProps: { text: "일반 메시지" },
        // A root sibling represents an adjacent DOM message and must not
        // affect classification of this row.
        sibling: {
          memoizedProps: {
            content_type: "MESSAGE_INLINE_SHARE",
            targetUrl: "https://www.instagram.com/reel/NEIGHBOR/",
          },
        },
      },
    });
  });
  await page.locator(".post-card").evaluate((element) => {
    Object.defineProperty(element, "__reactFiber$test", {
      enumerable: true,
      value: {
        memoizedProps: {
          content_type: "MESSAGE_INLINE_SHARE",
          targetUrl: "https://www.instagram.com/p/POST123/",
        },
      },
    });
  });

  const messages = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);

  assert.equal(messages[0]?.sender, "故추whw만함");
  assert.equal(messages[0]?.senderIdentity, "zxngw0o님의 프로필 사진");
  assert.equal(messages[0]?.text.trim(), "(릴스)");
  assert.equal(messages[0]?.kind, "reel");
  assert.equal(messages[1]?.sender, "박가은");
  assert.equal(messages[1]?.text.trim(), "축구 끝나고 집 가는 길(릴스)");
  assert.equal(messages[2]?.sender, "임규현");
  assert.equal(messages[2]?.text.trim(), "일반 메시지");
  assert.equal(messages[3]?.sender, "서정현");
  assert.equal(messages[3]?.text.trim(), "(게시물)");
  assert.equal(messages[3]?.kind, "post");
  assert.equal(messages[4]?.sender, "박가은");
  assert.equal(messages[4]?.text.trim(), "사진을 보냈습니다.");
  assert.equal(messages[4]?.kind, "image");
  assert.equal(messages[5]?.sender, "polalmkhksohn_ replied to hyeon_0627");
  assert.equal(messages[5]?.text.trim(), "집갔는데 문잠겨있다 이제");
});

test("프로필 사진은 Instagram 이미지 메시지로 오인하지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div>임규현</div>
        <div role="row"><img alt="임규현님의 프로필 사진" /><span>안녕하세요</span></div>
      </section>
    </main>
  `);

  const messages = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.text.trim(), "안녕하세요");
  assert.equal(messages[0]?.kind, undefined);
});

test("Instagram 시간 구분 라벨을 발신자 이름으로 사용하지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div role="row">
          <span>오전 9:20</span>
          <span>잘해먹노ㅠㅠㅜㅠ</span>
          <img alt="허동운님의 프로필 사진" />
        </div>
      </section>
    </main>
  `);

  const messages = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.sender, "허동운님의 프로필 사진");
  assert.notEqual(messages[0]?.sender, "오전 9:20");
});

test("Instagram 새 메시지 구분선을 발신자 이름으로 사용하지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div role="row">
          <span>New messages</span>
          <span>ㅠㅜㅠㅜㅜㅠ</span>
          <img alt="허동운님의 프로필 사진" />
        </div>
      </section>
    </main>
  `);

  const messages = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);

  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.sender, "허동운님의 프로필 사진");
  assert.notEqual(messages[0]?.sender, "New messages");
});

test("발신자 없는 연속 행은 그룹의 유일한 프로필 identity를 사용한다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div role="row"><img alt="故추whw만함님의 프로필 사진" /><span>ㅈ박은줄 알았는데</span></div>
        <div role="row"><span>최악정도는 아니네요</span></div>
        <div role="row"><span>34343</span></div>
        <div>이정민</div>
        <div role="row" aria-label="이정민 replied to 故추whw만함"><span>34343</span></div>
      </section>
    </main>
  `);

  const messages = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);

  assert.equal(messages[0]?.sender, "故추whw만함님의 프로필 사진");
  assert.equal(messages[1]?.sender, "故추whw만함님의 프로필 사진");
  assert.equal(messages[2]?.sender, "故추whw만함님의 프로필 사진");
  assert.equal(messages[3]?.sender, "이정민 replied to 故추whw만함");
});

test("답장 카드 안의 인용 row를 별도 메시지로 중복 파싱하지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <section>
        <div role="row" class="original">
          <img alt="zxngw0o님의 프로필 사진" />
          <span>34343</span>
        </div>
        <div role="row" class="reply" aria-label="이정민 replied to 故추whw만함">
          <div role="row" class="quoted-original"><span>34343</span></div>
          <span>34343</span>
        </div>
      </section>
    </main>
  `);

  const messages = await page
    .locator('main [role="row"]')
    .evaluateAll(readInstagramMessageRows);

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.sender, "zxngw0o님의 프로필 사진");
  assert.equal(messages[1]?.sender, "이정민 replied to 故추whw만함");
});

test("fallback 파서는 답장 카드의 버튼형 인용 원문을 별도 메시지로 만들지 않는다", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  await page.setContent(`
    <style>
      main { margin-left: 500px; width: 500px; height: 600px; }
      .bubble { width: 220px; min-height: 32px; border-radius: 12px; background: rgb(40, 40, 40); }
    </style>
    <main>
      <div role="group">
        <div>polalmkhksohn_ replied to 임규현</div>
        <div role="button"><div class="bubble">집갔는데 문잠겨있다 이제</div></div>
        <div class="bubble">아니지</div>
      </div>
      <div role="group"><div class="bubble">아니지</div></div>
    </main>
  `);

  const connector = new InstagramWebConnector({ profileDir: "/tmp/unused-profile" });
  const readVisibleMessages = (
    connector as unknown as {
      readVisibleMessages: (targetPage: typeof page, threadId: string) => Promise<Array<{
        kind: string;
        text: string;
        replyTo?: { sender?: string; text?: string };
      }>>;
    }
  ).readVisibleMessages.bind(connector);
  const messages = await readVisibleMessages(page, "thread-1");

  assert.deepEqual(messages.map(({ kind, text, replyTo }) => ({ kind, text, replyTo })), [
    {
      kind: "reply",
      text: "아니지",
      replyTo: { sender: "임규현", text: "집갔는데 문잠겨있다 이제" },
    },
    { kind: "text", text: "아니지", replyTo: undefined },
  ]);
});

test("이전 메시지 DOM이 깨어나기 전에 older 병합 방향을 설정한다", async () => {
  const connector = new InstagramWebConnector({ profileDir: "/tmp/unused-profile" });
  const internalState = connector as unknown as {
    loadingOlder: boolean;
    readVisibleMessages: () => Promise<Array<{
      id: string;
      threadId: string;
      kind: "text";
      sender: string;
      text: string;
    }>>;
  };
  let loadingOlderWhileScrolling = false;
  Object.assign(connector, {
    page: {
      url: () => "https://www.instagram.com/direct/t/thread-1/",
      waitForTimeout: async () => undefined,
      locator: () => ({
        evaluate: async () => {
          loadingOlderWhileScrolling = internalState.loadingOlder;
          return { moved: false, previousScrollTop: 0 };
        },
      }),
    },
  });
  internalState.readVisibleMessages = async () => [{
    id: "anchor",
    threadId: "thread-1",
    kind: "text",
    sender: "A",
    text: "anchor",
  }];

  assert.equal(await connector.loadOlderMessages(), 0);
  assert.equal(loadingOlderWhileScrolling, true);
  assert.equal(internalState.loadingOlder, false);
});

test("과거 DOM으로 이동한 뒤의 자동 refresh도 older 방향을 유지한다", async () => {
  const connector = new InstagramWebConnector({ profileDir: "/tmp/unused-profile" });
  const internalState = connector as unknown as {
    readingOlderWindow: boolean;
    readVisibleMessages: () => Promise<Array<{
      id: string;
      threadId: string;
      kind: "text";
      sender: string;
      text: string;
    }>>;
  };
  Object.assign(connector, {
    page: {
      url: () => "https://www.instagram.com/direct/t/thread-1/",
      waitForTimeout: async () => undefined,
      locator: () => ({
        evaluate: async () => ({ moved: true, previousScrollTop: 100 }),
      }),
    },
  });
  let readCount = 0;
  internalState.readVisibleMessages = async () => {
    readCount += 1;
    const anchor = {
      id: "anchor",
      threadId: "thread-1",
      kind: "text" as const,
      sender: "A",
      text: "anchor",
    };
    return readCount === 1
      ? [anchor]
      : [{ ...anchor, id: "older", text: "older" }, anchor];
  };

  await connector.loadOlderMessages();
  assert.equal(internalState.readingOlderWindow, true);
});

test("이동 전후 anchor가 끊기면 과거 DOM을 history에 반영하지 않는다", async () => {
  const connector = new InstagramWebConnector({ profileDir: "/tmp/unused-profile" });
  const internalState = connector as unknown as {
    readingOlderWindow: boolean;
    readVisibleMessages: () => Promise<Array<{
      id: string;
      threadId: string;
      kind: "text";
      sender: string;
      text: string;
    }>>;
  };
  Object.assign(connector, {
    page: {
      url: () => "https://www.instagram.com/direct/t/thread-1/",
      waitForTimeout: async () => undefined,
      locator: () => ({
        evaluate: async () => ({ moved: true, previousScrollTop: 100 }),
      }),
    },
  });
  let readCount = 0;
  internalState.readVisibleMessages = async () => [{
    id: `message-${readCount}`,
    threadId: "thread-1",
    kind: "text",
    sender: "A",
    text: readCount++ === 0 ? "known anchor" : "disconnected old row",
  }];

  assert.equal(await connector.loadOlderMessages(), 0);
  assert.equal(internalState.readingOlderWindow, false);
  assert.deepEqual(connector.getSnapshot().messages, []);
});

test("Instagram 화면 전환 중 사라진 execution context는 재시도 가능한 오류다", () => {
  assert.equal(
    isTransientInstagramNavigationError(
      new Error(
        "locator.evaluateAll: Execution context was destroyed, most likely because of a navigation",
      ),
    ),
    true,
  );
  assert.equal(isTransientInstagramNavigationError(new Error("Frame was detached")), true);
});

test("실제 DOM 오류는 화면 전환 오류로 숨기지 않는다", () => {
  assert.equal(
    isTransientInstagramNavigationError(new Error("locator.evaluateAll: selector is invalid")),
    false,
  );
});
