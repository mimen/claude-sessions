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
  | { action: "skip-retired"; sessionId: string };

/**
 * Pure planner for system resume: decides which members to resume, reanchor, or skip.
 * - completed/archived → skip-retired
 * - already live (cwd in liveByCwd) → reanchor (no relaunch)
 * - idle/parked + not live → resume with resumeId + cwd
 *
 * Idempotent: running twice against an all-live set yields all reanchor actions.
 */
export function planSystemResume(members: SystemMember[], liveByCwd: Set<string>): ResumeAction[] {
  const actions: ResumeAction[] = [];

  for (const member of members) {
    const lifecycle = lifecycleOf(member.catalogueRow);

    // Exclude completed/archived
    if (lifecycle === "completed" || lifecycle === "archived") {
      actions.push({ action: "skip-retired", sessionId: member.sessionId });
      continue;
    }

    // Check if already live by cwd
    if (liveByCwd.has(member.cwd)) {
      actions.push({ action: "reanchor", sessionId: member.sessionId });
      continue;
    }

    // Otherwise resume (idle/parked + not live)
    actions.push({
      action: "resume",
      sessionId: member.sessionId,
      resumeId: member.resumeId,
      cwd: member.cwd,
    });
  }

  return actions;
}
