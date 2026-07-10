/**
 * `ccs register-session` — the SessionStart hook entry (ADR-0017/0035).
 *
 * Reads the hook's JSON payload from stdin (`session_id`, `source`, `cwd`, …), runs the pure
 * registration/arming logic, and prints any `additionalContext` to stdout (Claude Code feeds
 * a SessionStart hook's stdout to the agent as context). ALWAYS exits 0 — a hook must never
 * block session start (fail-open, ADR-0035).
 */
import { openCatalogue, getRow } from "../catalogue/db.ts";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import { handleSessionStart, type SessionStartPayload } from "./register.ts";
import { composeClaudeMd } from "./compose-claude-md.ts";
import { runStartActions } from "./start-actions.ts";
import { composePredecessors } from "./compose-predecessors.ts";

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
    const db = openCatalogue(CATALOGUE_PATH());
    try {
      const res = handleSessionStart(db, payload, now());
      const parts: string[] = [];
      if (res.registered && payload.session_id) {
        const row = getRow(db, payload.session_id);
        if (row) {
          // Run the config-driven start actions (ADR-0044): arm, drain-inbox, etc., executed in
          // merged order. If a `start.json` ran an `arm` action, it OWNS arming — suppress
          // handleSessionStart's built-in re-arm note to avoid a duplicate. With no start.json,
          // the built-in re-arm note is the safety net.
          const started = runStartActions({ row, source: payload.source });
          const armedByConfig = started.ran.includes("arm");
          if (res.additionalContext && !armedByConfig) parts.push(res.additionalContext);
          if (started.context) parts.push(started.context);
          // Layered claude-md context composition (ADR-0043/0044).
          const composed = composeClaudeMd(row);
          if (composed.context) parts.push(composed.context);
          // Predecessor rehydration (ADR-0038): a FRESH embodiment (startup, not a resume of
          // its own transcript) is pointed at prior embodiments' transcripts of the same
          // identity. Skip on resume — that session keeps its own history.
          if (payload.source !== "resume") {
            const preds = composePredecessors(payload.session_id);
            if (preds) parts.push(preds);
          }
        }
      } else if (res.additionalContext) {
        // Unregistered: surface the ask-to-register note (no row to run start actions against).
        parts.push(res.additionalContext);
      }
      if (parts.length > 0) process.stdout.write(parts.join("\n\n") + "\n");
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
