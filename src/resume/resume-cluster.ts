/**
 * `ccs resume-cluster <cluster>` — a THIN loop over resume-session (ADR-0015).
 *
 * It runs resume-session once for every identity in the cluster that isn't already open,
 * sharing ONE cmux bridge snapshot across the whole pass (so liveness is consistent and we
 * don't re-shell `cmux tree` per member). No separate logic: the single-identity verb is the
 * primitive; this is just the fan-out. Idempotent — a second run is all skips.
 *
 * "cluster" is the public word; the catalogue column is still `system` (ADR-0037), so we
 * resolve members via sessionsForSystem.
 */
import type { Database } from "bun:sqlite";
import { sessionsForSystem } from "../catalogue/db.ts";
import { liveBridge } from "../cmux/live.ts";
import { resumeSessionEntry, type ResumeSessionResult } from "./resume-session.ts";

export interface ClusterResumeSummary {
  resumed: number;
  alreadyOpen: number;
  notIndexed: number;
  failed: number;
  perSession: { sessionId: string; result: ResumeSessionResult["status"] }[];
}

export function resumeClusterEntry(
  indexDb: Database,
  catalogueDb: Database,
  cluster: string,
  opts: { dryRun?: boolean; cmuxBin?: string } = {},
): ClusterResumeSummary {
  const sessionIds = sessionsForSystem(catalogueDb, cluster);
  // One bridge snapshot for the whole pass — consistent liveness, one `cmux tree` call.
  const bridge = liveBridge();

  const summary: ClusterResumeSummary = {
    resumed: 0,
    alreadyOpen: 0,
    notIndexed: 0,
    failed: 0,
    perSession: [],
  };

  for (const sessionId of sessionIds) {
    const res = resumeSessionEntry(indexDb, catalogueDb, sessionId, {
      dryRun: opts.dryRun,
      cmuxBin: opts.cmuxBin,
      bridge,
    });
    summary.perSession.push({ sessionId, result: res.status });
    switch (res.status) {
      case "resumed":
        summary.resumed++;
        break;
      case "already-open":
        summary.alreadyOpen++;
        break;
      case "not-indexed":
        summary.notIndexed++;
        break;
      case "spawn-failed":
        summary.failed++;
        break;
    }
  }
  return summary;
}
