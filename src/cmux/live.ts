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
const VERSION_CACHE_TTL_MS = 60_000;
const TREE_TIMEOUT_MS = 3_000;
const HOOK_STORE_TIMEOUT_MS = 2_000;
const PROCESS_KILL_GRACE_MS = 100;
const PROCESS_COMPLETION_SLACK_MS = 100;

/** Parsed cmux version. */
export interface CmuxVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface AsyncCmuxCommandResult {
  ok: boolean;
  stdout: string;
  /** Diagnostic channel for failed reads; optional so test fakes stay minimal. */
  stderr?: string;
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
export function cmuxVersion(cmuxBin = "cmux"): CmuxVersion | null {
  try {
    return parseVersion(execFileSync(cmuxBin, ["--version"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: VERSION_TIMEOUT_MS,
    }));
  } catch {
    return null;
  }
}

function readTree(cmuxBin = "cmux"): TreeResult {
  try {
    const output = execFileSync(cmuxBin, ["tree", "--all", "--json", "--id-format", "both"], {
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
  } else {
    log.warn("cmux version unreadable; liveness compatibility unknown, resume will fail closed", {
      tree: treeResult.ok ? "ok" : "failed",
    });
    readable = false;
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
export function liveBridge(cmuxBin = "cmux"): Bridge {
  const started = Date.now();
  const version = cmuxVersion(cmuxBin);
  const treeResult = readTree(cmuxBin);
  const storeResult = readHookStore();
  const bridge = finaliseBridge(version, treeResult, storeResult);
  recordProbe("cmux.bridge.sync.end", Date.now() - started, version, treeResult.ok, storeResult.ok, bridge.readable);
  return bridge;
}

function execFileAsync(file: string, args: readonly string[], timeoutMs: number): Promise<AsyncCmuxCommandResult> {
  return new Promise((resolve) => {
    let termTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(file, [...args], { encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (termTimer) clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: error === null,
        stdout: typeof stdout === "string" ? stdout : "",
        stderr: typeof stderr === "string" ? stderr : "",
      });
    });
    termTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), PROCESS_KILL_GRACE_MS);
    }, timeoutMs);
  });
}

function processBoundMs(timeoutMs: number): number {
  return timeoutMs + PROCESS_KILL_GRACE_MS + PROCESS_COMPLETION_SLACK_MS;
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

/**
 * The last logged tree-failure signature. A cmux outage makes every 2.5s liveness refresh fail the
 * same way; logging the reason once per distinct failure keeps the log readable while still
 * explaining WHY the sidebar froze instead of silently serving stale liveness forever.
 */
let lastTreeFailureSignature: string | null = null;

function noteTreeFailure(reason: string, stderr: string | undefined): void {
  const detail = (stderr ?? "").trim().slice(0, 300);
  const signature = `${reason}:${detail}`;
  if (signature === lastTreeFailureSignature) return;
  lastTreeFailureSignature = signature;
  log.warn("cmux tree read failed — liveness is now stale", {
    reason,
    ...(detail ? { stderr: detail } : {}),
  });
}

async function readTreeAsync(io: AsyncCmuxIo, cmuxBin: string): Promise<TreeResult> {
  const result = await boundedAsync(
    io.execFile(cmuxBin, ["tree", "--all", "--json", "--id-format", "both"], TREE_TIMEOUT_MS),
    processBoundMs(TREE_TIMEOUT_MS),
  );
  if (!result || !result.ok) {
    noteTreeFailure(result ? "command-failed" : "timed-out", result?.stderr);
    return { tree: { windows: [] }, ok: false };
  }
  try {
    const tree = JSON.parse(result.stdout) as CmuxTree;
    lastTreeFailureSignature = null;
    return { tree, ok: true };
  } catch {
    noteTreeFailure("unparseable-json", result.stderr);
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
  cmuxBin?: string;
  /** A server-scoped reader can reuse this immutable process fact while refreshing tree/store. */
  version?: Promise<CmuxVersion | null>;
}

async function readVersionAsync(io: AsyncCmuxIo, cmuxBin: string): Promise<CmuxVersion | null> {
  try {
    const result = await boundedAsync(
      io.execFile(cmuxBin, ["--version"], VERSION_TIMEOUT_MS),
      processBoundMs(VERSION_TIMEOUT_MS),
    );
    return result?.ok ? parseVersion(result.stdout) : null;
  } catch {
    return null;
  }
}

/**
 * Build a cmux bridge without synchronous process or filesystem work. Intended only for TUI
 * effects: the synchronous bridge remains the fail-closed API for resume and CLI callers.
 */
export async function liveBridgeAsync(options: LiveBridgeAsyncOptions | AsyncCmuxIo = {}): Promise<Bridge> {
  const configured = "execFile" in options ? { io: options } : options;
  const io = configured.io ?? productionAsyncIo;
  const cmuxBin = configured.cmuxBin ?? "cmux";
  const started = io.now();
  getCrashReporter()?.breadcrumb("cmux.bridge.async.start");
  const [version, treeResult, storeResult] = await Promise.all([
    configured.version ?? readVersionAsync(io, cmuxBin),
    readTreeAsync(io, cmuxBin),
    readHookStoreAsync(io, hookStorePath(configured.hookStorePath)),
  ]);
  const bridge = finaliseBridge(version, treeResult, storeResult);
  recordProbe("cmux.bridge.async.end", io.now() - started, version, treeResult.ok, storeResult.ok, bridge.readable);
  return bridge;
}

export interface LiveBridgeReaderOptions extends Omit<LiveBridgeAsyncOptions, "version"> {
  /** Successful version probes are reused only within this window. */
  versionTtlMs?: number;
}

/**
 * Create a long-lived Bridge reader for request servers. Every call still reads a fresh cmux tree
 * and hook store. Successful version probes are cached briefly; failed or unparseable probes are
 * shared only while in flight and retried by the next read. This removes steady-state process
 * spawns while eventually observing cmux upgrades and downgrades.
 */
export function createLiveBridgeReader(
  options: LiveBridgeReaderOptions = {},
): () => Promise<Bridge> {
  const { versionTtlMs: configuredVersionTtlMs, ...bridgeOptions } = options;
  const io = bridgeOptions.io ?? productionAsyncIo;
  const cmuxBin = bridgeOptions.cmuxBin ?? "cmux";
  const versionTtlMs = Math.max(0, configuredVersionTtlMs ?? VERSION_CACHE_TTL_MS);
  let cachedVersion: { readonly value: CmuxVersion; readonly expiresAt: number } | null = null;
  let versionFlight: Promise<CmuxVersion | null> | null = null;

  function versionForRead(): Promise<CmuxVersion | null> {
    if (cachedVersion && io.now() < cachedVersion.expiresAt) {
      return Promise.resolve(cachedVersion.value);
    }
    cachedVersion = null;
    if (versionFlight) return versionFlight;

    const flight = readVersionAsync(io, cmuxBin).then((version) => {
      if (version) {
        cachedVersion = { value: version, expiresAt: io.now() + versionTtlMs };
      }
      return version;
    });
    versionFlight = flight;
    void flight.finally(() => {
      if (versionFlight === flight) versionFlight = null;
    });
    return flight;
  }

  return () => liveBridgeAsync({ ...bridgeOptions, io, cmuxBin, version: versionForRead() });
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
