import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE_PATH = fileURLToPath(new URL("../../scripts/kakao-bridge.swift", import.meta.url));
const BINARY_PATH = path.join(os.tmpdir(), "terminal-dm-kakao-bridge");

interface BridgeResponse<T> {
  id: number;
  ok: boolean;
  result?: T;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class KakaoNativeBridge {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderr = "";

  public async start(): Promise<void> {
    if (this.process) return;
    await buildBridgeIfNeeded();
    const child = spawn(BINARY_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.once("exit", (code, signal) => {
      this.process = undefined;
      const detail = this.stderr.trim();
      const error = new Error(
        `Kakao native bridge가 종료됐습니다 (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`,
      );
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    await this.request("ping", {});
  }

  public async stop(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      };
      const termTimer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 1_000);
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", finish);
      child.once("close", finish);
    });
  }

  public request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    const child = this.process;
    if (!child?.stdin.writable) return Promise.reject(new Error("Kakao native bridge가 실행 중이 아닙니다."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    let response: BridgeResponse<unknown>;
    try {
      response = JSON.parse(line) as BridgeResponse<unknown>;
    } catch {
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.result);
    else request.reject(new Error(response.error ?? "Kakao native bridge 요청에 실패했습니다."));
  }
}

async function buildBridgeIfNeeded(): Promise<void> {
  const [source, binary] = await Promise.all([
    fs.stat(SOURCE_PATH),
    fs.stat(BINARY_PATH).catch(() => undefined),
  ]);
  if (binary && binary.mtimeMs >= source.mtimeMs) return;
  await execFileAsync("/usr/bin/swiftc", [SOURCE_PATH, "-o", BINARY_PATH], {
    maxBuffer: 4 * 1024 * 1024,
  });
}
