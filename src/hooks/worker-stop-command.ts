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
import { spawnSelfCheckDetached, resolveCcsBinary } from "./spawn-self-check.ts";

/**
 * Self-check delivery mode. Default: "sidecar". Controlled by CCS_SELF_CHECK_MODE:
 *   - "sidecar" (default): detach `ccs self-check <sid>` as a background process; main thread's
 *     turn ends cleanly with NO additionalContext injection. The sidecar reads recent transcript,
 *     asks a cheap Claude what to update, runs the resulting ccs commands. Deterministic,
 *     decoupled from main-thread output behavior.
 *   - "inline": legacy path — inject a pointer to the composed stop-context as additionalContext,
 *     forcing one continuation turn where the main agent runs the updates itself. Kept as an
 *     escape hatch in case sidecar wedges.
 *   - "off": no self-check at all.
 */
type SelfCheckMode = "sidecar" | "inline" | "off";
function selfCheckMode(): SelfCheckMode {
  const v = (process.env.CCS_SELF_CHECK_MODE ?? "sidecar").toLowerCase();
  if (v === "inline" || v === "off") return v;
  return "sidecar";
}

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
    const mode = selfCheckMode();
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    let registered = false;
    let pointerContext: string | null = null;
    let sidecarSessionId: string | null = null;
    try {
      // Only self-report for a registered session (has a role); a bare/foreign session is a no-op.
      const row = getRow(db, id);
      if (row?.role) {
        registered = true;
        // The self-check is a role-authored `stop-context` hook fragment (file-presence keyed).
        // A role that authors one gets a self-check; a role that doesn't, doesn't.
        // Continuation-Stop guard applies only to `inline` mode (it's the mode that re-prompts
        // via additionalContext). `sidecar` mode runs out-of-band; a continuation-Stop from an
        // earlier inline nudge is not this mode's concern.
        if (mode !== "off") {
          const composed = composeStopContext(row);
          if (composed) {
            if (mode === "sidecar") {
              // Fork the sidecar detached. Main-thread turn ends normally — no additionalContext,
              // no continuation. The sidecar runs a cheap claude -p out-of-band and executes any
              // `ccs` updates it decides on directly against this session id.
              sidecarSessionId = id;
            } else if (mode === "inline" && !isContinuationStop) {
              // Legacy inline path: materialize the fragment and inject a pointer as
              // additionalContext, forcing one continuation where the main agent runs the updates.
              try {
                const dir = identityDir(ccsRuntimeRoot(), responsibilityOf(row));
                mkdirSync(dir, { recursive: true });
                const path = join(dir, "stop-context.md");
                writeFileSync(path, composed, "utf8");
                pointerContext = `Turn-end self-check: read @${path} and run any \`ccs\` updates it warrants for state that changed this turn. Then produce ONE short line (one sentence, no headers/bullets/preamble) summarizing what you updated, or "self-check: no updates." if nothing changed. Do NOT explain, elaborate, or restate context — one terse line only.`;
              } catch {
                pointerContext = composed;
              }
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
    // Sidecar fork: after db close, before any output. Detached, so this returns fast (<10ms).
    if (sidecarSessionId) {
      spawnSelfCheckDetached(sidecarSessionId, resolveCcsBinary());
    }
    // Inject the inline pointer (or, on materialization failure, the raw fragment). Only fires in
    // `inline` mode; sidecar mode never writes to stdout so the Stop hook returns cleanly.
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
