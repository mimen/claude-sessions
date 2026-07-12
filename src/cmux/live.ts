/**
 * Live I/O for the cmux bridge: shell out to `cmux tree --all` and read cmux's 0.64 hook store
 * (`~/.cmuxterm/claude-hook-sessions.json`), then hand both to buildBridge. Kept separate from
 * bridge.ts so the parsing / resolution logic stays pure + fixture-tested (bridge.test.ts) and
 * this thin layer owns the side effects.
 *
 * READABILITY is a first-class result here (ADR-0054): a bridge built from sources we could not
 * read is NOT the same as "nothing is open". `readable` is true only if BOTH the tree command
 * succeeded AND the hook store was present+parseable. A missing store file is treated as
 * readable-but-empty (cmux installed, just no tracked sessions yet); a failed `cmux tree`
 * (binary absent, socket unauthed, non-zero exit) is UNREADABLE. Resume fails closed on it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildBridge,
  type Bridge,
  type CmuxHookStore,
  type CmuxTree,
} from "./bridge";

const HOOK_STORE_PATH =
  process.env.CMUX_HOOK_STORE_PATH ??
  join(homedir(), ".cmuxterm", "claude-hook-sessions.json");

/** Parsed cmux version. */
export interface CmuxVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Probe the cmux version via `cmux --version`. Returns {major, minor, patch} if parseable,
 * null if cmux is absent or the version string doesn't match \d+\.\d+\.\d+.
 */
export function cmuxVersion(): CmuxVersion | null {
  try {
    const out = execFileSync("cmux", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const match = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match || !match[1] || !match[2] || !match[3]) return null;
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
    };
  } catch {
    return null;
  }
}

/** Enumerate every window (ADR-0016): `--all` is required or the current window only. */
function readTree(): { tree: CmuxTree; ok: boolean } {
  try {
    const out = execFileSync(
      "cmux",
      ["tree", "--all", "--json", "--id-format", "both"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { tree: JSON.parse(out) as CmuxTree, ok: true };
  } catch {
    return { tree: { windows: [] }, ok: false }; // cmux down / unauthed -> UNREADABLE
  }
}

/**
 * Read the hook store. A missing file is readable-but-empty (cmux is installed, no sessions
 * tracked yet); a present-but-unparseable file is UNREADABLE (don't guess it's empty).
 */
function readHookStore(): { store: CmuxHookStore; ok: boolean } {
  if (!existsSync(HOOK_STORE_PATH)) return { store: {}, ok: true };
  try {
    return { store: JSON.parse(readFileSync(HOOK_STORE_PATH, "utf8")) as CmuxHookStore, ok: true };
  } catch {
    return { store: {}, ok: false };
  }
}

/** Build a bridge from the live cmux state on this machine. */
export function liveBridge(): Bridge {
  const version = cmuxVersion();
  const { tree, ok: treeOk } = readTree();
  const { store, ok: storeOk } = readHookStore();

  // Version guard (ADR-0054 fail-closed contract): if cmux < 0.64.0, the hook store can't be
  // trusted (it didn't exist) → prefer readable=false so resume fails closed rather than
  // re-spawning a fleet we can't see. If >= 1.0.0, warn about untested major version.
  let readable = treeOk && storeOk;
  if (version) {
    if (version.major === 0 && version.minor < 64) {
      console.warn(
        `cmux ${version.major}.${version.minor}.${version.patch} predates the hook store (0.64.0) — liveness unreadable, resume will fail closed`,
      );
      readable = false;
    } else if (version.major >= 1) {
      console.warn(
        `cmux ${version.major}.${version.minor}.${version.patch} is an untested major version (built for 0.64.x)`,
      );
    }
  } else if (!treeOk) {
    // When cmux is absent from PATH or socket is unauthed, surface the diagnostic explicitly
    // (ADR-task #9 hardening). Still fail-closed (readable=false), just clearer than silent.
    console.warn(
      "cmux binary not found in PATH or socket unauthed — liveness unreadable, resume will fail closed",
    );
  }

  return buildBridge(tree, store, readable);
}
