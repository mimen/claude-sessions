import type { Database } from "bun:sqlite";
import { sessionsForSystem, getRow } from "../catalogue/db.ts";
import { liveByCwd } from "../catalogue/live-by-cwd.ts";
import { planSystemResume, type SystemMember } from "./system.ts";
import { buildResumeCommand } from "./command.ts";
import { openInCmux } from "./cmux.ts";

/**
 * Execute a system resume: resolve the system's members, plan which to resume/reanchor/skip,
 * then launch `claude --resume` in cmux for each "resume" action. Idempotent: running twice
 * is a no-op the second time (everything now live → all reanchor).
 *
 * Returns the number of sessions actually resumed (0 when all already live).
 */
export function executeSystemResume(
  indexDb: Database,
  catalogueDb: Database,
  systemSlug: string,
  cmuxBin = "cmux",
): { resumed: number; reanchored: number; skipped: number; superseded: number } {
  // Resolve system members: session ids from catalogue, then join with Index for cwd + resumeId
  const sessionIds = sessionsForSystem(catalogueDb, systemSlug);
  if (sessionIds.length === 0) {
    console.error(`ccs: no sessions found for system "${systemSlug}"`);
    return { resumed: 0, reanchored: 0, skipped: 0, superseded: 0 };
  }

  const members: SystemMember[] = [];
  for (const sessionId of sessionIds) {
    const catalogueRow = getRow(catalogueDb, sessionId);
    // Join with Index to get cwd + resumeId
    const indexRow = indexDb
      .query("SELECT cwd, resume_id FROM sessions WHERE session_id = $id")
      .get({ $id: sessionId }) as { cwd: string | null; resume_id: string } | null;

    if (!indexRow || !indexRow.cwd) {
      console.warn(`ccs: skipping ${sessionId} (not indexed or missing cwd)`);
      continue;
    }

    members.push({
      sessionId,
      resumeId: indexRow.resume_id,
      cwd: indexRow.cwd,
      catalogueRow,
    });
  }

  if (members.length === 0) {
    console.error(`ccs: no indexed sessions with cwd for system "${systemSlug}"`);
    return { resumed: 0, reanchored: 0, skipped: 0, superseded: 0 };
  }

  // Derive live-by-cwd and plan
  const live = liveByCwd(cmuxBin);
  const actions = planSystemResume(members, live);

  // Execute
  let resumed = 0;
  let reanchored = 0;
  let skipped = 0;
  let superseded = 0;

  for (const action of actions) {
    switch (action.action) {
      case "resume": {
        const cmd = buildResumeCommand(
          { resumeId: action.resumeId } as any, // minimal duck-type for buildResumeCommand
          { fork: false, cwd: action.cwd },
        );
        // Use session id as workspace name (cmux will show it in the tab)
        const success = openInCmux(cmd, action.sessionId, cmuxBin);
        if (success) {
          console.log(`ccs: resumed ${action.sessionId} in ${action.cwd}`);
          resumed++;
        } else {
          console.error(`ccs: failed to resume ${action.sessionId} in cmux`);
        }
        break;
      }
      case "reanchor":
        console.log(`ccs: ${action.sessionId} already live (reanchored)`);
        reanchored++;
        break;
      case "skip-retired":
        console.log(`ccs: skipping ${action.sessionId} (retired: completed or archived)`);
        skipped++;
        break;
      case "superseded":
        // Another (fresher) session already owns this work unit — don't spawn a
        // duplicate pane for one PR. Not resumed, not an error.
        console.log(`ccs: superseding ${action.sessionId} (unit ${action.unit} owned by ${action.by.slice(0, 8)})`);
        superseded++;
        break;
    }
  }

  return { resumed, reanchored, skipped, superseded };
}
