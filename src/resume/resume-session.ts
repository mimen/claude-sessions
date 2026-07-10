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
import { execFileSync } from "node:child_process";
import type { Database } from "bun:sqlite";
import { sessionById, type SessionRow } from "../index/index.ts";
import type { Bridge } from "../cmux/bridge.ts";
import { liveBridge } from "../cmux/live.ts";
import { getRow } from "../catalogue/db.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "./command.ts";

/** Just the catalogue bits resume needs (kept narrow so the planner is easy to test). */
export interface ResumeMeta {
  resumeCommand: string | null;
}

export type ResumePlan =
  | { action: "skip"; reason: "already-open" }
  | { action: "resume"; command: ResumeCommand; name: string; note: string | null };

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
  return { action: "resume", command, name, note };
}

export type ResumeSessionResult =
  | { status: "resumed"; note: string | null }
  | { status: "already-open" }
  | { status: "not-indexed" }
  | { status: "spawn-failed" };

/**
 * The full `ccs resume-session <id>` entry: resolve the row + its resume_command, plan, and
 * (unless dry-run) execute. `bridge` defaults to the live cmux state; injectable for tests.
 */
export function resumeSessionEntry(
  indexDb: Database,
  catalogueDb: Database,
  sessionId: string,
  opts: { dryRun?: boolean; cmuxBin?: string; bridge?: Bridge } = {},
): ResumeSessionResult {
  const row = sessionById(indexDb, sessionId);
  if (!row) return { status: "not-indexed" };

  const cat = getRow(catalogueDb, sessionId);
  const bridge = opts.bridge ?? liveBridge();
  const plan = planResumeSession(bridge, row, { resumeCommand: cat?.resumeCommand ?? null });

  if (plan.action === "skip") return { status: "already-open" };
  if (opts.dryRun) return { status: "resumed", note: plan.note };
  return executeResumePlan(plan, opts.cmuxBin)
    ? { status: "resumed", note: plan.note }
    : { status: "spawn-failed" };
}

/** Execute a resume plan: spawn a new cmux workspace running the resume command. */
export function executeResumePlan(plan: ResumePlan, cmuxBin = "cmux"): boolean {
  if (plan.action === "skip") return false;
  try {
    execFileSync(
      cmuxBin,
      [
        "new-workspace",
        "--name",
        plan.name,
        "--cwd",
        plan.command.cwd,
        "--command",
        plan.command.shell,
        "--focus",
        "true",
      ],
      { timeout: 5000, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}
