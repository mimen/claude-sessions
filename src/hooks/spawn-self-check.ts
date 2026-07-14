/**
 * Fork the self-check sidecar (ADR-0063 v2). Called by the worker Stop hook.
 *
 * The Stop hook must return quickly (Claude Code blocks on it). The sidecar runs a
 * `claude -p` call that takes several seconds. So we DETACH: spawn the ccs self-check
 * subprocess with stdin/out/err disconnected and `.unref()` it, then return. The child keeps
 * running after the Stop hook exits; when it finishes, the worker's tab is updated.
 *
 * The child inherits nothing chatty — its logs go to a per-session file, not to the parent's
 * stderr (which would leak into Claude Code's hook feedback stream).
 */
import { openSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runtimeRoot } from "../paths.ts";

/**
 * Detached-spawn the sidecar for one session. Best-effort: any failure to launch is silently
 * swallowed (fail-open — a missed self-check just means the tab stays as-is until next Stop).
 */
export function spawnSelfCheckDetached(sessionId: string, ccsBinary: string): void {
  try {
    const logDir = join(runtimeRoot(), "self-check");
    mkdirSync(logDir, { recursive: true });
    const logFd = openSync(join(logDir, `${sessionId}.spawn.log`), "a");
    const proc = Bun.spawn([ccsBinary, "self-check", sessionId], {
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      // No cwd override — the child re-resolves its own sidecarCwd for the actual claude -p call.
    });
    // Fire and forget: don't await proc.exited, and detach so parent exit doesn't kill the child.
    // Bun.spawn returns a Subprocess; unref() lets Bun's event loop end without waiting.
    proc.unref();
  } catch { /* fail-open */ }
}

/**
 * Resolve the `ccs` binary path. Falls back to `ccs` on PATH; also honors CCS_BIN override for
 * tests. This is what the child process re-invokes to reach the CLI dispatcher.
 */
export function resolveCcsBinary(): string {
  return process.env.CCS_BIN ?? "ccs";
}
