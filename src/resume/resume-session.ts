/**
 * `ccs resume-session <id>` — the CORE resume operation (ADR-0015). Re-embody ONE identity:
 * if it's already open, skip (idempotent, no duplicate pane); else build `claude --resume
 * <id> [resume_command]` in the derived launch dir and spawn it in a cmux workspace.
 *
 * A loop (resume_command set) comes back RUNNING; a worker (no resume_command) gets a bare
 * resume and rehydrates from its inbox/state. `ccs resume-cluster` is a thin loop over this.
 *
 * Liveness is surface-keyed via the cmux bridge (ADR-0014/0040) — exact, no cwd/title guess.
 */
import type { Database } from "bun:sqlite";
import { sessionById, type SessionRow } from "../index/index.ts";
import type { Bridge } from "../cmux/bridge.ts";
import { liveBridge } from "../cmux/live.ts";
import { getRow, getAll, lifecycleOf } from "../catalogue/db.ts";
import { identityKey } from "../catalogue/lineage.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "./command.ts";
import { spawnCmux } from "./spawn-cmux.ts";
import { pushRenderOps } from "../catalogue/sync-tabs.ts";

/** Just the catalogue bits resume needs (kept narrow so the planner is easy to test). */
export interface ResumeMeta {
  resumeCommand: string | null;
}

export type ResumePlan =
  | { action: "skip"; reason: "already-open" }
  | { action: "resume"; sessionId: string; command: ResumeCommand; name: string; note: string | null }
  | { action: "fail"; reason: "cwd-unreadable"; error: string };

/** Is this session currently embodied? Check both the filename id and the resume id, since
 * cmux records the live Claude sessionId and either may match depending on how it was born. */
function sessionIsOpen(bridge: Bridge, row: SessionRow): boolean {
  return bridge.isOpen(row.resumeId) || bridge.isOpen(row.sessionId);
}

/** Pure planner: decide skip vs resume, and build the exact command. No I/O. */
export function planResumeSession(
  bridge: Bridge,
  row: SessionRow,
  meta: ResumeMeta | null,
): ResumePlan {
  if (sessionIsOpen(bridge, row)) {
    return { action: "skip", reason: "already-open" };
  }
  const cwdResult = resolveResumeCwd(row);
  if ("error" in cwdResult) {
    // FAIL CLOSED: filesystem error locating the launch dir (ADR-0066/0054).
    return { action: "fail", reason: "cwd-unreadable", error: cwdResult.error };
  }
  const { cwd, note } = cwdResult;
  const command = buildResumeCommand(row, {
    fork: false,
    cwd,
    resumeCommand: meta?.resumeCommand ?? null,
  });
  const name = row.title || row.sessionId;
  return { action: "resume", sessionId: row.sessionId, command, name, note };
}

export type ResumeSessionResult =
  | { status: "resumed"; note: string | null }
  | { status: "already-open" }
  | { status: "not-indexed" }
  | { status: "spawn-failed" }
  /** liveness sources were unreadable — we fail closed and spawn nothing (ADR-0054) */
  | { status: "liveness-unreadable" }
  /** cwd location failed with I/O error — fail closed per ADR-0066 */
  | { status: "cwd-unreadable"; error: string };

/**
 * The full `ccs resume-session <id>` entry: resolve the row + its resume_command, plan, and
 * (unless dry-run) execute. `bridge` defaults to the live cmux state; injectable for tests.
 */
export function resumeSessionEntry(
  indexDb: Database,
  catalogueDb: Database,
  sessionId: string,
  opts: { dryRun?: boolean; cmuxBin?: string; bridge?: Bridge; focus?: boolean } = {},
): ResumeSessionResult {
  const row = sessionById(indexDb, sessionId);
  if (!row) return { status: "not-indexed" };

  const cat = getRow(catalogueDb, sessionId);
  const bridge = opts.bridge ?? liveBridge();
  // FAIL CLOSED: if we can't read liveness we can't tell "already open" from "closed". Treating
  // unreadable as closed would re-spawn a session that's actually running → duplicate-fleet
  // runaway (ADR-0054). Abort instead — spawn nothing, report the reason.
  if (!bridge.readable) return { status: "liveness-unreadable" };
  const plan = planResumeSession(bridge, row, { resumeCommand: cat?.resumeCommand ?? null });

  if (plan.action === "skip") return { status: "already-open" };
  if (plan.action === "fail") return { status: "cwd-unreadable", error: plan.error };
  // ADR-0073: a second embodiment of an identity is TOLERATED, not refused — but surface it so the
  // operator can close a stale twin if they want. Best-effort + non-blocking: we're about to open
  // this (MRU) session; if OTHER live sessions share its identity-key, just warn.
  if (cat) warnLiveSiblings(catalogueDb, bridge, cat.sessionId, identityKey(cat));
  if (opts.dryRun) return { status: "resumed", note: plan.note };
  return executeResumePlan(plan, { cmuxBin: opts.cmuxBin, focus: opts.focus })
    ? { status: "resumed", note: plan.note }
    : { status: "spawn-failed" };
}

/**
 * Execute a resume plan: spawn a new detached cmux workspace running the resume command (via the
 * shared spawnCmux primitive — same env-scrub as new-session, ADR-0042), then EAGERLY paint the
 * tab from the session's ccs metadata so it renders correct immediately, without waiting for the
 * spawned session's own SessionStart hook to boot and fire (the cluster-resume tab-lag fix). The
 * hook remains the steady-state owner; this is just the first paint. Best-effort: a paint miss
 * (cmux may not have registered the new surface yet) is harmless — the hook repaints on boot.
 */
/**
 * Warn (never block) when OTHER live sessions share the identity we're about to resume (ADR-0073).
 * Duplicate embodiment is tolerated — MRU resume + atomic drain make it harmless — but a lingering
 * twin is worth flagging so the operator/control can close it. Best-effort: catalogue-only scan
 * against the same liveness bridge; any error is swallowed (a warning must never fail a resume).
 */
function warnLiveSiblings(catalogueDb: Database, bridge: Bridge, selfId: string, key: string | null): void {
  if (!key) return; // no identity-key (no role/work-unit) → nothing to compare
  try {
    const siblings: string[] = [];
    for (const [sid, row] of getAll(catalogueDb)) {
      if (sid === selfId) continue;
      const lc = lifecycleOf(row);
      if (lc === "completed" || lc === "archived") continue; // retired can't be a live twin
      if (identityKey(row) !== key) continue;
      if (bridge.isOpen(sid) || (row.resumeId && bridge.isOpen(row.resumeId))) siblings.push(sid);
    }
    if (siblings.length > 0) {
      const shown = siblings.slice(0, 5).map((s) => s.slice(0, 8)).join(", ");
      const more = siblings.length > 5 ? `, +${siblings.length - 5} more` : "";
      console.warn(
        `ccs: ${siblings.length} other live session(s) share identity "${key}" (${shown}${more}). ` +
          `Resuming the most-recently-used one; close the stale twin(s) if unwanted (ccs won't).`,
      );
    }
  } catch {
    /* warning is best-effort — never let it block a resume */
  }
}

export function executeResumePlan(
  plan: ResumePlan,
  opts: { cmuxBin?: string; focus?: boolean } = {},
): boolean {
  if (plan.action === "skip" || plan.action === "fail") return false;
  const ref = spawnCmux({
    argv: plan.command.argv,
    cwd: plan.command.cwd,
    name: plan.name,
    focus: opts.focus,
    cmuxBin: opts.cmuxBin,
  });
  if (ref === null) return false;
  try {
    // Paint the JUST-CREATED workspace by its ref — cmux hasn't bound surface→sessionId yet, so a
    // by-session lookup would miss (the eager-paint race). The hook repaints on boot regardless.
    pushRenderOps(plan.sessionId, opts.cmuxBin, ref);
  } catch {
    /* eager paint is best-effort; the SessionStart hook repaints on boot */
  }
  return true;
}
