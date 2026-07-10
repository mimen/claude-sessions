/**
 * `ccs hook run stop` — the turn-end self-report hook (ADR-0029/0033).
 *
 * On Stop, a role keeps itself current: it touches its ccs metadata (updated_at) so the
 * catalogue reflects that it just acted. (Richer self-report — phase from a result doc,
 * inbox ack — layers on once pr-watch writes its result/judgment into ccs state, Phase 6c.)
 *
 * Reads the Stop payload (session_id) from stdin. ALWAYS exits 0 (fail-open, ADR-0035).
 */
import { openCatalogue, getRow, touch } from "../catalogue/db.ts";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";

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

export async function workerStopCommand(): Promise<number> {
  try {
    const raw = await readStdin();
    const payload = JSON.parse(raw) as { session_id?: string };
    const id = payload?.session_id;
    if (!id) return 0;
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH);
    try {
      // Only self-report for a registered session (has a role); a bare/foreign session is a no-op.
      if (getRow(db, id)?.role) touch(db, id, now());
    } finally {
      db.close();
    }
  } catch {
    // fail-open
  }
  return 0;
}
