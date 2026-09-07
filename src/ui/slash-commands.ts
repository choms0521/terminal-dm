import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { AppLanguage } from "./i18n.js";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  usage: string;
}

const COMMANDS: Array<Omit<SlashCommand, "description"> & { descriptions: Record<AppLanguage, string> }> = [
  { name: "help", aliases: ["h"], descriptions: { ko: "명령과 단축키 보기", en: "Show commands and shortcuts" }, usage: "/help" },
  { name: "open", aliases: ["o"], descriptions: { ko: "이름으로 대화방 열기", en: "Open a conversation by name" }, usage: "/open <name>" },
  { name: "file", aliases: ["f", "send"], descriptions: { ko: "파일 전송 (KakaoTalk)", en: "Send a file (KakaoTalk)" }, usage: "/file <path> [<path> …]" },
  {
    name: "conversations",
    aliases: ["chats", "ls"],
    descriptions: { ko: "대화방 목록 보기", en: "Show conversations" },
    usage: "/conversations",
  },
  { name: "unread", aliases: ["u"], descriptions: { ko: "안 읽은 대화만 보기", en: "Show unread conversations" }, usage: "/unread" },
  { name: "all", aliases: ["a"], descriptions: { ko: "모든 대화 보기", en: "Show all conversations" }, usage: "/all" },
  {
    name: "connectors",
    aliases: ["status", "s"],
    descriptions: { ko: "채팅 connector 연결 상태 보기", en: "Show connector status" },
    usage: "/connectors",
  },
  {
    name: "history",
    aliases: ["older"],
    descriptions: { ko: "과거 대화 내역 열기", en: "Open message history" },
    usage: "/history",
  },
  { name: "model", aliases: ["models"], descriptions: { ko: "표시할 모델 선택", en: "Choose a display model" }, usage: "/model [name]" },
  { name: "theme", aliases: ["themes"], descriptions: { ko: "UI 색상 테마 선택", en: "Choose a UI theme" }, usage: "/theme [name]" },
  { name: "language", aliases: ["lang"], descriptions: { ko: "표시 언어 선택", en: "Choose the display language" }, usage: "/language [auto|ko|en]" },
  { name: "refresh", aliases: ["r"], descriptions: { ko: "connector 화면 다시 읽기", en: "Refresh connector views" }, usage: "/refresh" },
  { name: "update", descriptions: { ko: "terminal-dm 최신 버전 설치", en: "Install the latest terminal-dm version" }, usage: "/update" },
  { name: "clear", aliases: ["c"], descriptions: { ko: "현재 메시지 화면 비우기", en: "Clear the current message view" }, usage: "/clear" },
  { name: "exit", aliases: ["quit", "q"], descriptions: { ko: "terminal-dm 종료", en: "Exit terminal-dm" }, usage: "/exit" },
];

export function getSlashCommands(language: AppLanguage = "ko"): SlashCommand[] {
  return COMMANDS.map(({ descriptions, ...command }) => ({
    ...command,
    description: descriptions[language],
  }));
}

export const SLASH_COMMANDS = getSlashCommands("ko");

export type ParsedSubmission =
  | { kind: "empty" }
  | { kind: "message"; text: string }
  | { kind: "command"; name: string; args: string[] };

export function parseSubmission(value: string): ParsedSubmission {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.startsWith("//")) return { kind: "message", text: trimmed.slice(1) };
  if (!trimmed.startsWith("/")) return { kind: "message", text: trimmed };

  const [name = "", ...args] = trimmed.slice(1).trimStart().split(/\s+/);
  return { kind: "command", name: name.toLowerCase(), args };
}

/**
 * Splits a raw argument string into individual file paths using shell-style
 * quoting: whitespace separates paths, single or double quotes group a path
 * that contains spaces, and a backslash escapes the next character (so a
 * drag-and-dropped path like `my\ file.png` stays one token). Quote and escape
 * characters are removed from the result. Single-quoted spans are literal (no
 * escape processing). Empty tokens are dropped. Tilde (~) is left intact for
 * the caller to expand.
 */
export function tokenizeFileArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;

  const flush = () => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };

  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") escaped = true;
      else current += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      flush();
    } else {
      current += ch;
    }
  }
  if (escaped) current += "\\";
  flush();
  return tokens;
}

/** Resolves a single path token, expanding a leading ~ to the home directory. */
export function resolveFileToken(token: string): string {
  return token.startsWith("~")
    ? resolve(homedir(), token.slice(1).replace(/^\/+/, ""))
    : resolve(token);
}

function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Decides whether a raw submission should be treated as a drag-and-dropped (or
 * typed) file path to send, rather than a slash command or a text message.
 * True only when the input starts with a path prefix (/, ~/, ./ or ../) and
 * every token resolves to an existing regular file — so ordinary commands,
 * messages, and non-existent paths are never hijacked. A leading `//` forces a
 * literal message and is always excluded. `isFile` is injectable for testing.
 */
export function looksLikeFilePathInput(
  value: string,
  isFile: (path: string) => boolean = defaultIsFile,
): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("//")) return false;
  if (!/^(\/|~\/|\.{1,2}\/)/.test(trimmed)) return false;
  const tokens = tokenizeFileArgs(trimmed);
  if (tokens.length === 0) return false;
  return tokens.every((token) => isFile(resolveFileToken(token)));
}

export function filterSlashCommands(value: string, language: AppLanguage = "ko"): SlashCommand[] {
  const commands = getSlashCommands(language);
  if (!value.startsWith("/") || value.startsWith("//")) return [];
  const query = value.slice(1).trimStart().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!query) return commands;

  return commands.filter(
    (command) =>
      command.name.startsWith(query) ||
      command.aliases?.some((alias) => alias.startsWith(query)) ||
      command.description.toLowerCase().includes(query),
  );
}

export function findSlashCommand(name: string): SlashCommand | undefined {
  return getSlashCommands().find(
    (command) => command.name === name || command.aliases?.includes(name),
  );
}

export function wrapSelectionIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

export interface SelectionWindow<T> {
  items: T[];
  start: number;
  end: number;
}

export function getSelectionWindow<T>(
  items: T[],
  selectedIndex: number,
  windowSize: number,
): SelectionWindow<T> {
  const size = Math.max(1, Math.min(windowSize, items.length));
  const maxStart = Math.max(0, items.length - size);
  const start = Math.min(maxStart, Math.max(0, selectedIndex - size + 1));
  const end = start + size;
  return { items: items.slice(start, end), start, end };
}
