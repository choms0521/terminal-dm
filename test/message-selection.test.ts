import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, MessageKind } from "../src/domain.js";
import { getSelectedImageSelector, retainMessageSelection } from "../src/ui/message-selection.js";
import { reconcilePreviewIndexes, mergeKakaoMessageWindows } from "../src/connectors/kakao-native.js";
import { findSlashCommand, parseSubmission, getSelectionWindow, wrapSelectionIndex } from "../src/ui/slash-commands.js";
import { getCopy } from "../src/ui/i18n.js";
const message = (id: string, kind: MessageKind): ChatMessage => ({ id, kind, threadId: "room", text: id, sender: "sender" });

test("image selectors count photos and stickers from the bottom, excluding text and video", () => {
  const messages = [message("a", "image"), message("b", "text"), message("c", "sticker"), message("d", "video")];
  assert.equal(getSelectedImageSelector(messages, 0), 1);
  assert.equal(getSelectedImageSelector(messages, 2), 0);
  assert.equal(getSelectedImageSelector(messages, 1), undefined);
  assert.equal(getSelectedImageSelector(messages, -1), undefined);
  assert.equal(getSelectedImageSelector(messages, 4), undefined);
});

test("native image positions account for unloaded gaps in message history", () => {
  assert.equal(getSelectedImageSelector([{ ...message("a", "image"), previewIndex: 12 }], 0), 12);
  assert.equal(getSelectedImageSelector([message("stale", "image"), { ...message("current", "image"), previewIndex: 0 }], 0), undefined);
});

test("selection survives prepended history and appended messages by id", () => {
  const before = [message("a", "text"), message("b", "image")];
  const after = [message("old", "sticker"), ...before, message("new", "text")];
  assert.equal(retainMessageSelection(before, after, 1), 2);
  assert.equal(retainMessageSelection(before, [], 1), 0);
  assert.equal(retainMessageSelection(before, before.slice(0, 1), 1), 0);
  const selected = wrapSelectionIndex(0, -1, after.length);
  assert.equal(selected, 3);
  assert.deepEqual(getSelectionWindow(after, selected, 2).items.map((item) => item.id), ["b", "new"]);
});

test("changed or unknown image counts invalidate cached positions instead of guessing insertion side", () => {
  const messages = [{ ...message("a", "image"), previewIndex: 3, previewImageCount: 5 }];
  assert.equal(reconcilePreviewIndexes(messages, 7)[0]?.previewIndex, undefined);
  assert.equal(reconcilePreviewIndexes(messages, 7)[0]?.previewImageCount, undefined);
  assert.equal(reconcilePreviewIndexes(messages, 2)[0]?.previewIndex, undefined);
  assert.equal(reconcilePreviewIndexes(messages, NaN)[0]?.previewIndex, undefined);
  assert.equal(reconcilePreviewIndexes(messages, 5)[0]?.previewIndex, 3);
});

test("preview command and alias parse selection and explicit latest modes", () => {
  assert.equal(findSlashCommand("p")?.name, "preview");
  assert.equal(findSlashCommand("preview")?.usage, "/preview [select|latest]");
  assert.deepEqual(parseSubmission("/preview select"), { kind: "command", name: "preview", args: ["select"] });
  assert.deepEqual(parseSubmission("/p latest"), { kind: "command", name: "p", args: ["latest"] });
});

test("identical photo markers retain separate native selectors across overlapping windows", () => {
  const photo = (id: string, previewIndex: number) => ({ ...message(id, "image"), text: "photo", previewIndex, previewImageCount: 3 });
  const before = [photo("old-a", 2), photo("old-b", 1)];
  const incoming = [photo("refresh-b", 1), photo("new-c", 0)];
  const merged = mergeKakaoMessageWindows(before, incoming, "newer");
  assert.deepEqual(merged.map((item) => item.previewIndex), [2, 1, 0]);
  assert.deepEqual(merged.map((item) => item.id), ["old-a", "old-b", "new-c"]);
  assert.ok(merged.every((item) => item.timestamp === undefined && item.text === "photo"));
});

test("preview status and permission notices exist in both languages", () => {
  for (const language of ["ko", "en"] as const) {
    const copy = getCopy(language);
    for (const key of ["previewCapturing", "previewShown", "previewNotVisible", "previewTerminalUnsupported", "previewNoImage", "previewPermission", "previewFailed", "previewSelectionKeys"] as const) {
      assert.ok(copy[key].length > 0);
    }
  }
});
