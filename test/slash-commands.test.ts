import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  filterSlashCommands,
  findSlashCommand,
  getSelectionWindow,
  looksLikeFilePathInput,
  parseComposedMessage,
  parseSubmission,
  tokenizeFileArgs,
  wrapSelectionIndex,
} from "../src/ui/slash-commands.js";

const anyFile = () => true;
const noFile = () => false;

test("parseComposedMessage preserves text-only input", () => {
  const text = String.raw`Don't change  "quoted text" or back\slashes`;
  assert.deepEqual(parseComposedMessage(`  ${text}  `, anyFile), [
    { kind: "text", text },
  ]);
});

test("parseComposedMessage returns no segments for empty input", () => {
  assert.deepEqual(parseComposedMessage("", anyFile), []);
  assert.deepEqual(parseComposedMessage(" \n\t ", anyFile), []);
});

test("parseComposedMessage resolves and groups files-only input", () => {
  assert.deepEqual(parseComposedMessage("/tmp/a.png ~/b.png ./c.png ../d.png", anyFile), [
    {
      kind: "files",
      paths: ["/tmp/a.png", resolve(homedir(), "b.png"), resolve("c.png"), resolve("../d.png")],
    },
  ]);
});

test("parseComposedMessage preserves text-file-text order", () => {
  assert.deepEqual(parseComposedMessage("안녕하세요 ~/x.png 이거   봐봐", anyFile), [
    { kind: "text", text: "안녕하세요" },
    { kind: "files", paths: [resolve(homedir(), "x.png")] },
    { kind: "text", text: "이거 봐봐" },
  ]);
});

test("parseComposedMessage groups consecutive images and text tokens", () => {
  assert.deepEqual(parseComposedMessage("look   here ./a.png ./b.png then ./c.png", anyFile), [
    { kind: "text", text: "look here" },
    { kind: "files", paths: [resolve("a.png"), resolve("b.png")] },
    { kind: "text", text: "then" },
    { kind: "files", paths: [resolve("c.png")] },
  ]);
});

test("parseComposedMessage honors the literal override without checking files", () => {
  assert.deepEqual(parseComposedMessage('  //hello  "~/a.png"  ', () => {
    assert.fail("Literal input must not check files");
  }), [{ kind: "text", text: '/hello  "~/a.png"' }]);
});

test("parseComposedMessage leaves missing paths as text", () => {
  assert.deepEqual(parseComposedMessage("look ~/missing.png ./missing.jpg", noFile), [
    { kind: "text", text: "look ~/missing.png ./missing.jpg" },
  ]);
  assert.deepEqual(parseComposedMessage("./missing.png ./a.png ../missing.jpg", (path) => path === resolve("a.png")), [
    { kind: "text", text: "./missing.png" },
    { kind: "files", paths: [resolve("a.png")] },
    { kind: "text", text: "../missing.jpg" },
  ]);
});

test("parseComposedMessage requires a path prefix for every file token", () => {
  const checked: string[] = [];
  assert.deepEqual(parseComposedMessage("a.png ./b.png c.png", (path) => {
    checked.push(path);
    return true;
  }), [
    { kind: "text", text: "a.png" },
    { kind: "files", paths: [resolve("b.png")] },
    { kind: "text", text: "c.png" },
  ]);
  assert.deepEqual(checked, [resolve("b.png")]);
});

test("parseComposedMessage supports quoted and escaped file paths", () => {
  assert.deepEqual(parseComposedMessage(String.raw`look "~/my photo.png" './other photo.png' ./escaped\ photo.png now`, anyFile), [
    { kind: "text", text: "look" },
    {
      kind: "files",
      paths: [resolve(homedir(), "my photo.png"), resolve("other photo.png"), resolve("escaped photo.png")],
    },
    { kind: "text", text: "now" },
  ]);
});

test("parseComposedMessage preserves contractions before a file", () => {
  assert.deepEqual(parseComposedMessage("don't miss ~/x.png please", anyFile), [
    { kind: "text", text: "don't miss" },
    { kind: "files", paths: [resolve(homedir(), "x.png")] },
    { kind: "text", text: "please" },
  ]);
});

test("parseComposedMessage preserves contractions after a file", () => {
  assert.deepEqual(parseComposedMessage("here ~/x.png don't miss it", anyFile), [
    { kind: "text", text: "here" },
    { kind: "files", paths: [resolve(homedir(), "x.png")] },
    { kind: "text", text: "don't miss it" },
  ]);
});

test("slash command를 파싱한다", () => {
  assert.deepEqual(parseSubmission("/open 김태현"), {
    kind: "command",
    name: "open",
    args: ["김태현"],
  });
});

test("이중 slash는 일반 메시지로 처리한다", () => {
  assert.deepEqual(parseSubmission("//hello"), { kind: "message", text: "/hello" });
});

test("명령 이름과 별칭을 검색한다", () => {
  assert.equal(filterSlashCommands("/ref")[0]?.name, "refresh");
  assert.equal(findSlashCommand("q")?.name, "exit");
  assert.equal(findSlashCommand("quit")?.name, "exit");
  assert.equal(findSlashCommand("ls")?.name, "conversations");
  assert.equal(findSlashCommand("connectors")?.name, "connectors");
  assert.equal(findSlashCommand("status")?.name, "connectors");
  assert.equal(findSlashCommand("s")?.name, "connectors");
  assert.equal(findSlashCommand("older")?.name, "history");
  assert.equal(findSlashCommand("models")?.name, "model");
  assert.equal(findSlashCommand("lang")?.name, "language");
  assert.equal(findSlashCommand("update")?.name, "update");
  assert.match(filterSlashCommands("/", "en")[0]?.description ?? "", /commands/i);
});

test("file 명령과 별칭을 검색하고 경로 인자를 파싱한다", () => {
  assert.equal(findSlashCommand("file")?.name, "file");
  assert.equal(findSlashCommand("f")?.name, "file");
  assert.equal(findSlashCommand("send")?.name, "file");
  assert.deepEqual(parseSubmission("/file ~/photo.png"), {
    kind: "command",
    name: "file",
    args: ["~/photo.png"],
  });
});

test("tokenizeFileArgs는 공백으로 여러 경로를 나눈다", () => {
  assert.deepEqual(tokenizeFileArgs("a.png b.png"), ["a.png", "b.png"]);
});

test("tokenizeFileArgs는 따옴표로 묶인 공백 포함 경로를 보존한다", () => {
  assert.deepEqual(tokenizeFileArgs('"my photo.png" c.jpg'), ["my photo.png", "c.jpg"]);
  assert.deepEqual(tokenizeFileArgs("'single quoted.png'"), ["single quoted.png"]);
});

test("tokenizeFileArgs는 여분의 공백을 접고 빈 입력은 빈 배열이다", () => {
  assert.deepEqual(tokenizeFileArgs("   a.png    b.png   "), ["a.png", "b.png"]);
  assert.deepEqual(tokenizeFileArgs(""), []);
  assert.deepEqual(tokenizeFileArgs("   "), []);
});

test("tokenizeFileArgs는 빈 따옴표 토큰을 버린다", () => {
  assert.deepEqual(tokenizeFileArgs('""'), []);
  assert.deepEqual(tokenizeFileArgs("''"), []);
  assert.deepEqual(tokenizeFileArgs('a.png "" b.png'), ["a.png", "b.png"]);
});

test("tokenizeFileArgs는 따옴표가 붙은 조각을 이어 붙인다", () => {
  assert.deepEqual(tokenizeFileArgs('foo"bar baz"'), ["foobar baz"]);
});

test("tokenizeFileArgs는 역슬래시로 이스케이프된 공백을 경로에 포함한다", () => {
  assert.deepEqual(tokenizeFileArgs("my\\ file.png"), ["my file.png"]);
  assert.deepEqual(tokenizeFileArgs("/Users/mscho/내\\ 사진.png b.png"), [
    "/Users/mscho/내 사진.png",
    "b.png",
  ]);
});

test("tokenizeFileArgs는 틸드 경로를 그대로 둔다", () => {
  assert.deepEqual(tokenizeFileArgs("~/pics/x.jpg \"~/내 사진.png\""), [
    "~/pics/x.jpg",
    "~/내 사진.png",
  ]);
});

test("looksLikeFilePathInput은 존재하는 경로 입력을 파일로 인식한다", () => {
  assert.equal(looksLikeFilePathInput("/Users/me/x.png", anyFile), true);
  assert.equal(looksLikeFilePathInput("~/x.png", anyFile), true);
  assert.equal(looksLikeFilePathInput("./a.png ./b.png", anyFile), true);
});

test("looksLikeFilePathInput은 //로 시작하면 리터럴 메시지로 남긴다", () => {
  assert.equal(looksLikeFilePathInput("//Users/me/report.pdf", anyFile), false);
});

test("looksLikeFilePathInput은 명령·일반 메시지를 가로채지 않는다", () => {
  assert.equal(looksLikeFilePathInput("/help", noFile), false);
  assert.equal(looksLikeFilePathInput("hello world", anyFile), false);
  // /file 명령은 첫 토큰(/file)이 파일이 아니므로 파일 입력으로 오인하지 않는다
  assert.equal(
    looksLikeFilePathInput("/file /Users/me/x.png", (path) => path.endsWith("x.png")),
    false,
  );
});

test("looksLikeFilePathInput은 존재하지 않는 경로는 무시한다", () => {
  assert.equal(looksLikeFilePathInput("/Users/me/nope.png", noFile), false);
});

test("slash 뒤 공백이 있어도 exit 명령을 파싱한다", () => {
  assert.deepEqual(parseSubmission("/ exit"), {
    kind: "command",
    name: "exit",
    args: [],
  });
});

test("command palette 선택이 위아래로 순환한다", () => {
  assert.equal(wrapSelectionIndex(8, 1, 9), 0);
  assert.equal(wrapSelectionIndex(0, -1, 8), 7);
  assert.equal(wrapSelectionIndex(2, 1, 0), 0);
});

test("선택 항목이 창 아래를 넘으면 목록을 위로 스크롤한다", () => {
  assert.deepEqual(getSelectionWindow([0, 1, 2, 3, 4], 3, 3), {
    items: [1, 2, 3],
    start: 1,
    end: 4,
  });
  assert.deepEqual(getSelectionWindow([0, 1, 2, 3, 4], 0, 3), {
    items: [0, 1, 2],
    start: 0,
    end: 3,
  });
});
