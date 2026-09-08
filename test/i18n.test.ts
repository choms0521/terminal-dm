import assert from "node:assert/strict";
import test from "node:test";

import { getCopy, isLanguagePreference, resolveLanguage } from "../src/ui/i18n.js";

test("explicit language overrides the terminal locale", () => {
  assert.equal(resolveLanguage("en", { LANG: "ko_KR.UTF-8" }), "en");
  assert.equal(resolveLanguage("ko", { LANG: "en_US.UTF-8" }), "ko");
});

test("auto language follows common locale variables", () => {
  assert.equal(resolveLanguage("auto", { LANG: "ko_KR.UTF-8" }), "ko");
  assert.equal(resolveLanguage(undefined, { LC_ALL: "en_US.UTF-8" }), "en");
});

test("language preferences and copy are available in Korean and English", () => {
  assert.equal(isLanguagePreference("auto"), true);
  assert.equal(isLanguagePreference("ja"), false);
  assert.equal(getCopy("ko").selectConversation, "대화를 선택하세요");
  assert.equal(getCopy("en").selectConversation, "Select a conversation");
  assert.equal(getCopy("ko").sendingComposedMessage, "메시지와 이미지를 순서대로 전송 중…");
  assert.equal(getCopy("en").sendingComposedMessage, "Sending message and images…");
  assert.match(getCopy("ko").starPrompt, /스타/);
  assert.match(getCopy("en").starPrompt, /GitHub star/);
  assert.equal(getCopy("ko").updateAvailable, "✔ Update available");
  assert.equal(getCopy("en").updateAvailable, "✔ Update available");
  assert.equal(getCopy("ko").updateInstalled, "✔ Update installed · Restart to update");
  assert.equal(getCopy("en").updateInstalled, "✔ Update installed · Restart to update");
});
