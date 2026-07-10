/**
 * `ccs register-session` — the SessionStart hook entry (ADR-0017/0035).
 *
 * Reads the hook's JSON payload from stdin (`session_id`, `source`, `cwd`, …), runs the pure
 * registration/arming logic, and prints any `additionalContext` to stdout (Claude Code feeds
 * a SessionStart hook's stdout to the agent as context). ALWAYS exits 0 — a hook must never
 * block session start (fail-open, ADR-0035).
 */
import { openCatalogue } from "../catalogue/db.ts";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import { handleSessionStart, type SessionStartPayload } from "./register.ts";

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

async function readStdin(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

export async function registerSessionCommand(): Promise<number> {
  // Everything here is best-effort: any failure must still exit 0 so the session proceeds.
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as SessionStartPayload;
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH);
    try {
      const res = handleSessionStart(db, payload, now());
      if (res.additionalContext) process.stdout.write(res.additionalContext + "\n");
    } finally {
      db.close();
    }
    // ADR-0029: a role keeps its own surfaces current — paint this session's cmux tab from
    // its ccs metadata on start. Best-effort; a miss (e.g. cmux not yet aware of the surface)
    // is retried on the next hook fire. Never blocks the session.
    if (payload?.session_id) {
      try {
        const { pushRenderOps } = await import("../catalogue/sync-tabs.ts");
        pushRenderOps(payload.session_id);
      } catch {
        /* fail-open */
      }
    }
  } catch {
    // Malformed payload / unreachable catalogue / anything — fail open, say nothing.
  }
  return 0;
}
