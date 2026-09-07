import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveBrowserExecutable } from "../src/browser/resolve-browser.js";

test("기본 브라우저와 무관하게 Playwright Chromium을 선택한다", () => {
  assert.deepEqual(
    resolveBrowserExecutable({}, "/playwright/chromium", () => true),
    {
      label: "Playwright Chromium",
      executablePath: "/playwright/chromium",
    },
  );
});

test("명시된 custom Chromium만 기본 Playwright 실행 파일보다 우선한다", () => {
  const configured = "./custom-chromium";
  assert.deepEqual(
    resolveBrowserExecutable({ TERMINAL_DM_BROWSER: configured }, "/playwright/chromium", () => true),
    {
      label: "custom Chromium",
      executablePath: path.resolve(configured),
    },
  );
});

test("Playwright Chromium이 설치되지 않았으면 설치 안내를 표시한다", () => {
  assert.throws(
    () => resolveBrowserExecutable({}, "/missing/chromium", () => false),
    /npm install script/,
  );
});
