import { spawn } from "node:child_process";

const LATEST_PACKAGE_URL = "https://registry.npmjs.org/terminal-dm/latest";

export function isNewerVersion(current: string, candidate: string): boolean {
  const left = parseVersion(current);
  const right = parseVersion(candidate);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (right[index]! !== left[index]!) return right[index]! > left[index]!;
  }
  return false;
}

export async function checkForUpdate(
  currentVersion: string,
  fetchLatest: typeof fetch = fetch,
  timeoutMs = 1_200,
): Promise<string | undefined> {
  try {
    const response = await fetchLatest(LATEST_PACKAGE_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { version?: unknown };
    const candidate = typeof payload.version === "string" ? payload.version : undefined;
    return candidate && isNewerVersion(currentVersion, candidate) ? candidate : undefined;
  } catch {
    // Update checks must never delay or prevent the messenger from starting.
    return undefined;
  }
}

export function installLatestVersion(options: { silent?: boolean } = {}): Promise<void> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolve, reject) => {
    const child = spawn(
      npmCommand,
      ["install", "--global", "--allow-scripts=terminal-dm", "terminal-dm@latest"],
      { stdio: options.silent ? "ignore" : "inherit" },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm update failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function parseVersion(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
