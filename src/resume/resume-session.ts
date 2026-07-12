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
import { getRow } from "../catalogue/db.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "./command.ts";
import { spawnCmux } from "./spawn-cmux.ts";
import { pushRenderOps } from "../catalogue/sync-tabs.ts";

/** Just the catalogue bits resume needs (kept narrow so the planner is easy to test). */
export interface ResumeMeta {
  resumeCommand: string | null;
}

export type ResumePlan =
  | { action: "skip"; reason: "already-open" }
  | { action: "resume"; sessionId: string; command: ResumeCommand; name: string; note: string | null };

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
  const { cwd, note } = resolveResumeCwd(row);
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
  | { status: "liveness-unreadable" };

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
export function executeResumePlan(
  plan: ResumePlan,
  opts: { cmuxBin?: string; focus?: boolean } = {},
): boolean {
  if (plan.action === "skip") return false;
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
