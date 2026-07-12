import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { DATA_DIR } from "./paths.ts";

/**
 * Durable crash + debug logging. A fullscreen Ink app wipes its own stack trace when the
 * alternate screen closes, so crashes look like "ccs just exited". Everything fatal lands in
 * ~/.claude-sessions/crash.log; breadcrumbs land in ccs-debug.log when CCS_DEBUG=1.
 */
export const CRASH_LOG = join(DATA_DIR, "crash.log");
export const DEBUG_LOG = join(DATA_DIR, "ccs-debug.log");

function append(file: string, text: string): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(file, text);
  } catch {
    // logging must never be the thing that crashes
  }
}

function record(kind: string, err: unknown): void {
  const stack = err instanceof Error ? err.stack ?? err.message : String(err);
  append(
    CRASH_LOG,
    `\n[${new Date().toISOString()}] ${kind} · ccs v${pkg.version} · argv: ${process.argv.slice(2).join(" ") || "(tui)"}\n${stack}\n`,
  );
}

/** Leave the terminal usable after a fatal error inside the fullscreen TUI. */
function restoreTerminal(): void {
  try {
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m");
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  } catch {
    // best effort
  }
}

let installed = false;
export function installCrashLog(): void {
  if (installed) return;
  installed = true;
  process.on("uncaughtException", (err) => {
    record("uncaughtException", err);
    restoreTerminal();
    console.error(`ccs crashed — details in ${CRASH_LOG}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    // Bun treats these as fatal too; log before it dies.
    record("unhandledRejection", err);
    restoreTerminal();
    console.error(`ccs crashed (unhandled rejection) — details in ${CRASH_LOG}`);
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
}

/** Breadcrumb trail, only when CCS_DEBUG=1. One line per event, timestamped. */
export function debugLog(event: string, detail?: string): void {
  if (process.env["CCS_DEBUG"] !== "1") return;
  append(DEBUG_LOG, `[${new Date().toISOString()}] ${event}${detail ? ` · ${detail}` : ""}\n`);
}
