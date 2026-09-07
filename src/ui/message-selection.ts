import type { ChatMessage } from "../domain.js";

/** Native positions cover gaps between loaded history and the newest messages. */
export function getSelectedImageSelector(messages: ChatMessage[], selectedIndex: number): number | undefined {
  const message = messages[selectedIndex];
  if (!message || (message.kind !== "image" && message.kind !== "sticker")) return undefined;
  if (message.previewIndex !== undefined) return message.previewIndex;
  // Never reinterpret an invalidated native position as an index in the UI's
  // partial cache; that could select a different, still-mapped photo.
  if (messages.some((item) => item.previewIndex !== undefined)) return undefined;
  return messages.slice(selectedIndex + 1).filter(
    (item) => item.kind === "image" || item.kind === "sticker",
  ).length;
}

export function retainMessageSelection(previous: ChatMessage[], next: ChatMessage[], index: number): number {
  const selected = previous[index];
  const retained = selected ? next.findIndex((message) => message.id === selected.id) : -1;
  return retained >= 0 ? retained : Math.max(0, Math.min(index, next.length - 1));
}
