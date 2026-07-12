import type { CatalogueRow } from "../catalogue/db.ts";
import { drain } from "../inbox/inbox.ts";
import { identityDir, ccsRuntimeRoot, type Responsibility } from "../inbox/identity-path.ts";
import { resolveConfig } from "./resolve-config.ts";
import { liveResolveCtx } from "./compose-claude-md.ts";
import type { Action } from "./merge.ts";
import { workUnitPath } from "../catalogue/spawn-contract.ts";
import { catchUp } from "../cluster/changelog.ts";

/**
 * The `start` hook action runner (ADR-0044, execute-deterministically): a session's resolved
 * `start` config is an ORDERED list of actions; on SessionStart the hook EXECUTES each in merged
 * order (arm → drain-inbox → load-facts …) rather than injecting a checklist the agent might
 * skip. Actions that surface something the agent must see (drained inbox messages, a re-arm note)
 * return `context` strings that the caller appends to the SessionStart additionalContext, so a
 * side-effect (like draining) never loses information.
 *
 * Deterministic + fail-open: an action that throws is recorded and skipped; the rest still run.
 * The handler table is injectable so the runner is testable without a live inbox.
 */

export interface StartActionCtx {
  row: CatalogueRow;
  /** The SessionStart source (startup/resume/clear/compact) — arm only acts on resume. */
  source: string;
}

export interface ActionOutcome {
  /** Text to surface to the agent (appended to additionalContext), or null. */
  context: string | null;
  /** A problem to record (action still counts as run; fail-open). */
  error?: string;
}

export type ActionHandler = (action: Action, ctx: StartActionCtx) => ActionOutcome;

/** The responsibility key for a row (for locating its inbox). Mirrors the identity resolver. */
export function responsibilityOf(row: CatalogueRow): Responsibility {
  return {
    cluster: row.cluster ?? null,
    role: row.role ?? "unknown",
    epic: row.groupingId ?? null,
    // canonical filesystem-safe key — MUST match the hook-level dir (resolve-levels.workUnitOf)
    // so a worker's inbox dir and its config dir resolve identically. Previously a no-seg
    // `repo-num` form that diverged for slash'd repos (the P0 inbox-routing bug).
    workUnit: workUnitPath(row),
  };
}

/** Built-in action handlers. Each is deterministic and fail-open. */
export const BUILTIN_ACTIONS: Record<string, ActionHandler> = {
  // arm: re-fire the loop's resume_command on resume so it comes back RUNNING (ADR-0015). The
  // hook can't run the slash-command itself, so it surfaces the exact command as context — but
  // ONLY on resume and ONLY for a row that has one (deterministic condition, not agent guesswork).
  arm: (_action, ctx) => {
    if (ctx.source !== "resume" || !ctx.row.resumeCommand) return { context: null };
    return { context: `Re-arm this loop if it isn't already running: ${ctx.row.resumeCommand}` };
  },

  // drain-inbox: EXECUTE the drain (move-on-drain, ADR-0033) and hand the content to the agent.
  // Draining is a real side-effect; returning the bodies as context guarantees nothing is lost.
  "drain-inbox": (_action, ctx) => {
    const dir = identityDir(ccsRuntimeRoot(), responsibilityOf(ctx.row));
    const msgs = drain(dir);
    if (msgs.length === 0) return { context: null };
    const body = msgs.map((m) => `— from ${m.sender}:\n${m.body}`).join("\n\n");
    return { context: `You have ${msgs.length} inbox message(s) (drained just now):\n\n${body}` };
  },

  // catch-up: on SessionStart (startup OR resume), surface the cluster CHANGELOG entries this
  // identity hasn't seen, then advance its last-seen stamp (ADR-0058). This is the deterministic
  // replacement for "read the changelog each tick" — a hook the agent can't skip. The stamp only
  // advances AFTER the delta is added to context, so a session killed before its next turn
  // re-surfaces the same entries next start (idempotent, same contract as move-on-drain).
  "catch-up": (_action, ctx) => {
    const cluster = ctx.row.cluster;
    if (!cluster) return { context: null }; // no cluster → no changelog to catch up on
    // Shared core with `ccs catch-up` (the per-tick path for long-lived loops). Fires on every
    // SessionStart source (startup + resume): a resume is exactly when a session that missed a
    // mid-flight bump must catch up.
    return { context: catchUp(cluster, responsibilityOf(ctx.row)).context };
  },
};

/** Every start action name that has a built-in handler (for `ccs hooks lint` to flag typos). */
export function knownStartActions(): string[] {
  return Object.keys(BUILTIN_ACTIONS);
}

/** Resolve + run a session's start actions. Returns the merged context + any errors. */
export function runStartActions(
  ctx: StartActionCtx,
  handlers: Record<string, ActionHandler> = BUILTIN_ACTIONS,
): { context: string | null; errors: string[]; ran: string[] } {
  let actions: Action[] = [];
  try {
    const res = resolveConfig(ctx.row, "start", liveResolveCtx());
    actions = (res.effective as Action[] | null) ?? [];
  } catch {
    return { context: null, errors: ["start config unresolved"], ran: [] };
  }
  const parts: string[] = [];
  const errors: string[] = [];
  const ran: string[] = [];
  for (const action of actions) {
    const handler = handlers[action.name];
    if (!handler) { errors.push(`no handler for start action "${action.name}"`); continue; }
    try {
      const out = handler(action, ctx);
      ran.push(action.name);
      if (out.context) parts.push(out.context);
      if (out.error) errors.push(out.error);
    } catch (e) {
      errors.push(`start action "${action.name}" threw: ${(e as Error).message}`);
    }
  }
  return { context: parts.length > 0 ? parts.join("\n\n") : null, errors, ran };
}
