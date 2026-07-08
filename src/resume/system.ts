import type { CatalogueRow } from "../catalogue/db.ts";
import { lifecycleOf } from "../catalogue/db.ts";

/** A system member with its Index cwd, resumeId, and catalogue metadata. */
export interface SystemMember {
  readonly sessionId: string;
  readonly resumeId: string;
  readonly cwd: string;
  readonly catalogueRow: CatalogueRow | null;
}

/** Actions for system resume planning. */
export type ResumeAction =
  | { action: "resume"; sessionId: string; resumeId: string; cwd: string }
  | { action: "reanchor"; sessionId: string }
  | { action: "skip-retired"; sessionId: string }
  | { action: "superseded"; sessionId: string; unit: string; by: string };

/** The work unit a session belongs to — the thing that must have ONE live worker.
 * Prefer the PR key, else the GUS work item, else the cwd (worktree). A session
 * with none of those is its own unit (its sessionId), so it's never deduped away. */
function workUnit(m: SystemMember): string {
  const r = m.catalogueRow;
  if (r?.prRepo && r?.prNumber != null) return `pr:${r.prRepo}#${r.prNumber}`;
  if (r?.gusWork) return `gus:${r.gusWork}`;
  if (m.cwd) return `cwd:${m.cwd}`;
  return `sid:${m.sessionId}`;
}

/**
 * Pure planner for system resume: decides which members to resume, reanchor, or skip.
 * - completed/archived → skip-retired
 * - already live (cwd in liveByCwd) → reanchor (no relaunch)
 * - idle/parked + not live → resume with resumeId + cwd
 * - a NON-live session whose work unit (PR/gus/cwd) already has a fresher session
 *   resuming (or already live) → superseded (do NOT spawn a duplicate pane for one PR)
 *
 * ONE LIVE WORKER PER WORK UNIT: multiple sessions can accrue on a single PR
 * (build + rebase + diagnose); resuming all of them would put N panes on one PR —
 * the collision the architecture forbids. The freshest session per unit wins; older
 * ones are superseded. Freshness = catalogue updatedAt (falls back to input order).
 *
 * Idempotent: running twice against an all-live set yields all reanchor actions.
 */
export function planSystemResume(members: SystemMember[], liveByCwd: Set<string>): ResumeAction[] {
  const actions: ResumeAction[] = [];
  // Per work unit: the sessionId that is (or will be) the live worker for it.
  const claimed = new Map<string, string>();

  const isRetired = (m: SystemMember): boolean => {
    const lc = lifecycleOf(m.catalogueRow);
    return lc === "completed" || lc === "archived";
  };

  // PASS 1 — a LIVE session always claims its unit, regardless of freshness. A live
  // process must never be superseded by a fresher-but-dead sibling (that would spawn
  // a duplicate pane for one PR). Retired sessions never claim.
  for (const member of members) {
    if (isRetired(member)) continue;
    if (liveByCwd.has(member.cwd)) {
      actions.push({ action: "reanchor", sessionId: member.sessionId });
      claimed.set(workUnit(member), member.sessionId);
    }
  }

  // PASS 2 — the rest, freshest-first so the newest non-live session wins an unclaimed
  // unit and older siblings are superseded.
  const ts = (m: SystemMember): string => m.catalogueRow?.updatedAt ?? "";
  const rest = members
    .filter((m) => !liveByCwd.has(m.cwd))
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (ts(b.m) < ts(a.m) ? -1 : ts(b.m) > ts(a.m) ? 1 : a.i - b.i))
    .map((x) => x.m);

  for (const member of rest) {
    if (isRetired(member)) {
      actions.push({ action: "skip-retired", sessionId: member.sessionId });
      continue;
    }
    const unit = workUnit(member);
    const owner = claimed.get(unit);
    if (owner) {
      actions.push({ action: "superseded", sessionId: member.sessionId, unit, by: owner });
      continue;
    }
    actions.push({
      action: "resume",
      sessionId: member.sessionId,
      resumeId: member.resumeId,
      cwd: member.cwd,
    });
    claimed.set(unit, member.sessionId);
  }

  return actions;
}
