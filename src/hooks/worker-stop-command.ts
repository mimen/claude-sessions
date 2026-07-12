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
import { openCatalogue, getRow, touch, type CatalogueRow } from "../catalogue/db.ts";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import { resolveConfig } from "./resolve-config.ts";
import { liveResolveCtx } from "./compose-claude-md.ts";
import { isPhaseWorker, phaseRubric } from "./phase-rubric.ts";

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
    const db = openCatalogue(CATALOGUE_PATH());
    let registered = false;
    let worker: CatalogueRow | null = null;
    try {
      // Only self-report for a registered session (has a role); a bare/foreign session is a no-op.
      const row = getRow(db, id);
      if (row?.role) {
        registered = true;
        if (isPhaseWorker(row)) worker = row;
        const fields = metaUpdateFields(db, row);
        // `updated_at` is the one field a stop hook can refresh on its own (the heartbeat).
        if (fields.includes("updated_at")) touch(db, id, now());
      }
    } finally {
      db.close();
    }
    // Inject the phase self-check at turn-end (a pr-agent only). Non-blocking additionalContext —
    // the worker re-evaluates + self-sets its activity next turn; never forces an extra turn (no
    // `decision: block`), so there's zero loop risk (verified against the Stop hook contract).
    if (worker) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: phaseRubric(worker) },
      }) + "\n");
    }
    // Repaint the tab on turn-end so it reflects whatever this turn changed (PR merged, parked,
    // lifecycle flip, …). SessionStart alone painted once and then drifted; Stop keeps it fresh
    // every turn. Best-effort + late (db already closed): a paint miss never fails the hook.
    if (registered) {
      try {
        const { pushRenderOps } = await import("../catalogue/sync-tabs.ts");
        pushRenderOps(id);
      } catch {
        /* fail-open — the tab just stays as last painted */
      }
    }
  } catch {
    // fail-open
  }
  return 0;
}
