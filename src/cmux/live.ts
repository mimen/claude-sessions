/**
 * Live I/O for the cmux bridge. Parsing/resolution stays in bridge.ts; this module owns the
 * synchronous CLI path and the non-blocking TUI path.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCrashReporter } from "../crashlog.ts";
import { log } from "../logger.ts";
import {
  buildBridge,
  type Bridge,
  type CmuxHookStore,
  type CmuxTree,
} from "./bridge";

function hookStorePath(override?: string): string {
  return override ?? process.env.CMUX_HOOK_STORE_PATH ?? join(homedir(), ".cmuxterm", "claude-hook-sessions.json");
}
const VERSION_TIMEOUT_MS = 2_000;
const TREE_TIMEOUT_MS = 3_000;
const HOOK_STORE_TIMEOUT_MS = 2_000;

/** Parsed cmux version. */
export interface CmuxVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface AsyncCmuxCommandResult {
  ok: boolean;
  stdout: string;
}

/** Narrow TUI-test seam. Production uses callback execFile plus node:fs promises. */
export interface AsyncCmuxIo {
  execFile(file: string, args: readonly string[], timeoutMs: number): Promise<AsyncCmuxCommandResult>;
  readFile(path: string): Promise<{ found: boolean; content: string | null }>;
  now(): number;
}

interface TreeResult { tree: CmuxTree; ok: boolean }
interface StoreResult { store: CmuxHookStore; ok: boolean }

function parseVersion(output: string): CmuxVersion | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/** Probe cmux version synchronously for existing non-TUI callers. */
export function cmuxVersion(): CmuxVersion | null {
  try {
    return parseVersion(execFileSync("cmux", ["--version"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: VERSION_TIMEOUT_MS,
    }));
  } catch {
    return null;
  }
}

function readTree(): TreeResult {
  try {
    const output = execFileSync("cmux", ["tree", "--all", "--json", "--id-format", "both"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: TREE_TIMEOUT_MS,
    });
    return { tree: JSON.parse(output) as CmuxTree, ok: true };
  } catch {
    return { tree: { windows: [] }, ok: false };
  }
}

function readHookStore(path = hookStorePath()): StoreResult {
  if (!existsSync(path)) return { store: {}, ok: true };
  try {
    return { store: JSON.parse(readFileSync(path, "utf8")) as CmuxHookStore, ok: true };
  } catch {
    return { store: {}, ok: false };
  }
}

function finaliseBridge(version: CmuxVersion | null, treeResult: TreeResult, storeResult: StoreResult): Bridge {
  let readable = treeResult.ok && storeResult.ok;
  if (version) {
    if (version.major === 0 && version.minor < 64) {
      log.warn("cmux predates the hook store — liveness unreadable, resume will fail closed", { version: `${version.major}.${version.minor}.${version.patch}` });
      readable = false;
    } else if (version.major >= 1) {
      log.warn("cmux is an untested major version", { version: `${version.major}.${version.minor}.${version.patch}` });
    }
  } else if (!treeResult.ok) {
    log.warn("cmux binary not found or socket unauthed — liveness unreadable, resume will fail closed");
  }
  return buildBridge(treeResult.tree, storeResult.store, readable, pidIsAlive);
}

function recordProbe(event: string, durationMs: number, version: CmuxVersion | null, treeOk: boolean, storeOk: boolean, readable: boolean): void {
  getCrashReporter()?.breadcrumb(event, {
    durationMs: Math.max(0, Math.round(durationMs)),
    version: version ? `${version.major}.${version.minor}.${version.patch}` : null,
    tree: treeOk ? "ok" : "failed",
    store: storeOk ? "ok" : "failed",
    readable,
  });
}

/** Build a bridge from live cmux state synchronously for CLI/resume callers. */
export function liveBridge(): Bridge {
  const started = Date.now();
  const version = cmuxVersion();
  const treeResult = readTree();
  const storeResult = readHookStore();
  const bridge = finaliseBridge(version, treeResult, storeResult);
  recordProbe("cmux.bridge.sync.end", Date.now() - started, version, treeResult.ok, storeResult.ok, bridge.readable);
  return bridge;
}

function execFileAsync(file: string, args: readonly string[], timeoutMs: number): Promise<AsyncCmuxCommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({ ok: error === null, stdout: typeof stdout === "string" ? stdout : "" });
    });
  });
}

const productionAsyncIo: AsyncCmuxIo = {
  execFile: execFileAsync,
  async readFile(path: string): Promise<{ found: boolean; content: string | null }> {
    try {
      return { found: true, content: await readFile(path, "utf8") };
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return { found: false, content: null };
      }
      throw error;
    }
  },
  now: () => Date.now(),
};

async function boundedAsync<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readTreeAsync(io: AsyncCmuxIo): Promise<TreeResult> {
  const result = await boundedAsync(
    io.execFile("cmux", ["tree", "--all", "--json", "--id-format", "both"], TREE_TIMEOUT_MS),
    TREE_TIMEOUT_MS,
  );
  if (!result || !result.ok) return { tree: { windows: [] }, ok: false };
  try {
    return { tree: JSON.parse(result.stdout) as CmuxTree, ok: true };
  } catch {
    return { tree: { windows: [] }, ok: false };
  }
}

async function readHookStoreAsync(io: AsyncCmuxIo, path: string): Promise<StoreResult> {
  try {
    const file = await boundedAsync(io.readFile(path), HOOK_STORE_TIMEOUT_MS);
    if (!file) return { store: {}, ok: false };
    if (!file.found) return { store: {}, ok: true };
    return { store: JSON.parse(file.content ?? "") as CmuxHookStore, ok: true };
  } catch {
    return { store: {}, ok: false };
  }
}

export interface LiveBridgeAsyncOptions {
  io?: AsyncCmuxIo;
  hookStorePath?: string;
}

/**
 * Build a cmux bridge without synchronous process or filesystem work. Intended only for TUI
 * effects: the synchronous bridge remains the fail-closed API for resume and CLI callers.
 */
export async function liveBridgeAsync(options: LiveBridgeAsyncOptions | AsyncCmuxIo = {}): Promise<Bridge> {
  const configured = "execFile" in options ? { io: options } : options;
  const io = configured.io ?? productionAsyncIo;
  const started = io.now();
  getCrashReporter()?.breadcrumb("cmux.bridge.async.start");
  const [versionResult, treeResult, storeResult] = await Promise.all([
    boundedAsync(io.execFile("cmux", ["--version"], VERSION_TIMEOUT_MS), VERSION_TIMEOUT_MS),
    readTreeAsync(io),
    readHookStoreAsync(io, hookStorePath(configured.hookStorePath)),
  ]);
  const version = versionResult?.ok ? parseVersion(versionResult.stdout) : null;
  const bridge = finaliseBridge(version, treeResult, storeResult);
  recordProbe("cmux.bridge.async.end", io.now() - started, version, treeResult.ok, storeResult.ok, bridge.readable);
  return bridge;
}

/** POSIX liveness probe; EPERM means the process exists but is not signalable by us. */
function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
