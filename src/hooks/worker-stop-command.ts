/**
 * `ccs hook run stop` — the turn-end self-report hook (ADR-0029/0033/0044).
 *
 * On Stop, a role keeps itself current by refreshing the metadata fields its resolved
 * `meta-update` config declares (ADR-0044 set-union). Today the only field a stop hook can
 * refresh deterministically without an external value source is `updated_at` (a timestamp) —
 * so it touches when `updated_at` is in the resolved set. Other fields (phase, pr_state,
 * result) need a per-field VALUE PROVIDER, which is a deliberate follow-up decision, not
 * invented here; they're refreshed by their own writers (the worker's result doc, git sense).
 *
 * Reads the Stop payload (session_id) from stdin. ALWAYS exits 0 (fail-open, ADR-0035).
 */
import { openCatalogue, getRow, touch } from "../catalogue/db.ts";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import { resolveConfig } from "./resolve-config.ts";
import { liveResolveCtx } from "./compose-claude-md.ts";

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

/** The metadata fields this session's resolved meta-update config asks to refresh. Falls back to
 * the base {updated_at} for any registered session so the heartbeat never regresses. */
function metaUpdateFields(db: ReturnType<typeof openCatalogue>, row: NonNullable<ReturnType<typeof getRow>>): string[] {
  try {
    const res = resolveConfig(row, "meta-update", liveResolveCtx());
    const fields = (res.effective as string[] | null) ?? [];
    return fields.length > 0 ? fields : ["updated_at"];
  } catch {
    return ["updated_at"]; // fail-open to the base heartbeat
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
      const row = getRow(db, id);
      if (row?.role) {
        const fields = metaUpdateFields(db, row);
        // `updated_at` is the one field a stop hook can refresh on its own (the heartbeat).
        if (fields.includes("updated_at")) touch(db, id, now());
      }
    } finally {
      db.close();
    }
  } catch {
    // fail-open
  }
  return 0;
}
