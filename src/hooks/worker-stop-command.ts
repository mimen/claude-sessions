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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCatalogue, getRow, touch } from "../catalogue/db.ts";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import { resolveConfig } from "./resolve-config.ts";
import { liveResolveCtx, composeStopContext } from "./compose-claude-md.ts";
import { identityDir, ccsRuntimeRoot } from "../inbox/identity-path.ts";
import { responsibilityOf } from "./start-actions.ts";

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
    const payload = JSON.parse(raw) as { session_id?: string; stop_hook_active?: boolean };
    const id = payload?.session_id;
    if (!id) return 0;
    // ADR-0063 loop guard: a Stop hook that emits `additionalContext` FORCES a continuation (the
    // Claude Code contract treats it as feedback that continues the conversation, NOT a passive
    // note). So injecting the self-check re-prompts the worker, whose reply ends the turn, firing
    // Stop again → without a guard this loops until CLAUDE_CODE_STOP_HOOK_BLOCK_CAP trips. Claude
    // Code sets `stop_hook_active: true` on exactly those continuation-Stops: inject the self-check
    // on the NATURAL stop only, then let the worker's re-evaluation turn end for real. One nudge,
    // one continuation — never a loop.
    const isContinuationStop = payload?.stop_hook_active === true;
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    let registered = false;
    let pointerContext: string | null = null;
    try {
      // Only self-report for a registered session (has a role); a bare/foreign session is a no-op.
      const row = getRow(db, id);
      if (row?.role) {
        registered = true;
        // ADR-0063: the turn-end self-check is a role-authored `stop-context` hook fragment,
        // resolved through the normal layering (file-presence keyed), NOT a hardcoded pr-agent
        // rubric. Any role/cluster that authors one gets it; roles that don't, don't. Skip it on a
        // continuation-Stop (already nudged this stop) so it can never re-trigger itself.
        if (!isContinuationStop) {
          const composed = composeStopContext(row);
          if (composed) {
            // Materialize the resolved fragment to the identity's runtime dir and inject only a
            // pointer + silent-mode instruction. This keeps the visible tool-result block to one
            // line instead of the full merged fragment, and tells the worker to execute any state
            // updates via tool calls without emitting user-facing text on the continuation turn.
            try {
              const dir = identityDir(ccsRuntimeRoot(), responsibilityOf(row));
              mkdirSync(dir, { recursive: true });
              const path = join(dir, "stop-context.md");
              writeFileSync(path, composed, "utf8");
              pointerContext = `Silent turn-end self-check: read @${path} and run any \`ccs\` updates it warrants for state that changed this turn. Tool calls only — produce NO user-facing text on this continuation. If nothing changed, emit no tool calls and end the turn.`;
            } catch {
              // Materialization failed — fall back to injecting the composed text directly so the
              // self-check still fires (the reason it exists is more important than the preview
              // trim). One-off; not expected in practice.
              pointerContext = composed;
            }
          }
        }
        const fields = metaUpdateFields(db, row);
        // `updated_at` is the one field a stop hook can refresh on its own (the heartbeat).
        if (fields.includes("updated_at")) touch(db, id, now());
      }
    } finally {
      db.close();
    }
    // Inject the pointer (or, on materialization failure, the raw fragment) at turn-end. This
    // forces ONE continuation (the worker re-evaluates + self-sets its activity), bounded by the
    // stop_hook_active guard above so the follow-up Stop injects nothing and the turn ends.
    if (pointerContext) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "Stop", additionalContext: pointerContext },
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
