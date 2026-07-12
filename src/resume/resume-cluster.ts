/**
 * `ccs resume-cluster <cluster>` — resume every not-open identity in a cluster (ADR-0015).
 *
 * A thin fan-out over resume-session, but with two cluster-level guards the single-identity
 * verb can't see on its own (ported from the old planSystemResume, ADR-0008/0010):
 *  - RETIRED skip: a completed (merged) or archived (closed) member is done — never revived.
 *  - SUPERSEDE dedup: at most ONE live worker per work-unit. If a work-unit already has a
 *    live session, an older dead sibling for the same unit is NOT resumed (that would spawn
 *    a duplicate pane for one PR). Freshest non-live session wins an unclaimed unit.
 *
 * Shares ONE cmux bridge snapshot across the pass (consistent liveness, one `cmux tree`).
 * "cluster" is the public word; members resolve via the `system` column (ADR-0037).
 */
import type { Database } from "bun:sqlite";
import { sessionsForSystem, getRow, lifecycleOf, type CatalogueRow } from "../catalogue/db.ts";
import { liveBridge } from "../cmux/live.ts";
import { openSessionIdsFrom } from "../cmux/liveness.ts";
import type { Bridge } from "../cmux/bridge.ts";
import { resumeSessionEntry, type ResumeSessionResult } from "./resume-session.ts";
import { workUnitKey } from "../catalogue/spawn-contract.ts";

export type MemberDisposition = ResumeSessionResult["status"] | "retired" | "superseded";

export interface ClusterResumeSummary {
  resumed: number;
  alreadyOpen: number;
  retired: number;
  superseded: number;
  notIndexed: number;
  failed: number;
  /** true iff the pass ABORTED because cmux liveness was unreadable — nothing was spawned (ADR-0054) */
  abortedUnreadable: boolean;
  perSession: { sessionId: string; result: MemberDisposition }[];
}

/** The work-unit a session belongs to (pr → gus → sid). The pr/gus tiers use the canonical
 * key (spawn-contract.workUnitKey); a keyless session falls back to its own id so dedup still
 * gives it a unique slot. */
function workUnit(row: CatalogueRow | null, sessionId: string): string {
  return (row ? workUnitKey(row) : null) ?? `sid:${sessionId}`;
}

interface PlannedMember {
  sessionId: string;
  row: CatalogueRow | null;
  disposition: "retired" | "superseded" | "resume-candidate";
}

/**
 * Pure pre-plan: classify each member as retired / superseded / resume-candidate, BEFORE any
 * spawn. `isLive(sessionId, resumeId)` reports whether a session is currently embodied.
 */
export function planClusterMembers(
  members: { sessionId: string; row: CatalogueRow | null }[],
  isLive: (sessionId: string, resumeId: string | null) => boolean,
): PlannedMember[] {
  const live = (m: { sessionId: string; row: CatalogueRow | null }) =>
    isLive(m.sessionId, m.row?.resumeId ?? null);
  const retired = (m: { row: CatalogueRow | null }) => {
    const lc = lifecycleOf(m.row);
    return lc === "completed" || lc === "archived";
  };

  // PASS 1 — a LIVE, non-retired session claims its unit (regardless of freshness). A live
  // process must never be superseded by a fresher-but-dead sibling.
  const claimed = new Set<string>();
  for (const m of members) {
    if (!retired(m) && live(m)) claimed.add(workUnit(m.row, m.sessionId));
  }

  // PASS 2 — the rest, freshest-first, so the newest non-live session wins an unclaimed unit
  // and older siblings for a claimed unit are superseded.
  const ts = (m: { row: CatalogueRow | null }) => m.row?.updatedAt ?? "";
  const ordered = members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (ts(b.m) < ts(a.m) ? -1 : ts(b.m) > ts(a.m) ? 1 : a.i - b.i))
    .map((x) => x.m);

  const out: PlannedMember[] = [];
  for (const m of ordered) {
    if (retired(m)) {
      out.push({ sessionId: m.sessionId, row: m.row, disposition: "retired" });
      continue;
    }
    if (live(m)) {
      // already claimed in pass 1 — resume-session will report it already-open
      out.push({ sessionId: m.sessionId, row: m.row, disposition: "resume-candidate" });
      continue;
    }
    const unit = workUnit(m.row, m.sessionId);
    if (claimed.has(unit)) {
      out.push({ sessionId: m.sessionId, row: m.row, disposition: "superseded" });
      continue;
    }
    claimed.add(unit); // this non-live session now owns the unit; older siblings supersede
    out.push({ sessionId: m.sessionId, row: m.row, disposition: "resume-candidate" });
  }
  // restore input order for stable reporting
  const byId = new Map(out.map((p) => [p.sessionId, p]));
  return members.map((m) => byId.get(m.sessionId)!);
}

export function resumeClusterEntry(
  indexDb: Database,
  catalogueDb: Database,
  cluster: string,
  opts: { dryRun?: boolean; cmuxBin?: string; bridge?: Bridge; focus?: boolean } = {},
): ClusterResumeSummary {
  return resumeMany(indexDb, catalogueDb, sessionsForSystem(catalogueDb, cluster), opts);
}

/**
 * Resume a SET of session ids — the shared core behind `ccs resume-cluster`, `ccs resume
 * <selector>`, and the TUI. Applies the two cluster-level guards (retired-skip, one-live-worker-
 * per-work-unit supersede-dedup) then delegates each survivor to resumeSessionEntry (the single
 * per-session resume core). A single-id set naturally resolves to plain resume-session behavior.
 */
export function resumeMany(
  indexDb: Database,
  catalogueDb: Database,
  sessionIds: string[],
  opts: { dryRun?: boolean; cmuxBin?: string; bridge?: Bridge; focus?: boolean } = {},
): ClusterResumeSummary {
  const bridge = opts.bridge ?? liveBridge();
  const emptySummary = (): ClusterResumeSummary => ({
    resumed: 0, alreadyOpen: 0, retired: 0, superseded: 0, notIndexed: 0, failed: 0,
    abortedUnreadable: false, perSession: [],
  });

  // FAIL CLOSED: without readable liveness the supersede-dedup can't tell which units are already
  // live, so a whole-cluster resume would re-spawn every running worker → duplicate fleet. Abort
  // the ENTIRE pass (spawn nothing) rather than fan out blind (ADR-0054).
  if (!bridge.readable) return { ...emptySummary(), abortedUnreadable: true };

  const openIds = openSessionIdsFrom(bridge);
  const isLive = (sessionId: string, resumeId: string | null) =>
    openIds.has(sessionId) || (resumeId != null && openIds.has(resumeId));

  // A selector can return the same id via >1 axis (e.g. role + cluster); dedupe so the planner
  // sees each session once and we never double-spawn.
  const uniqueIds = [...new Set(sessionIds)];
  const members = uniqueIds.map((sessionId) => ({ sessionId, row: getRow(catalogueDb, sessionId) }));
  const planned = planClusterMembers(members, isLive);

  const summary = emptySummary();

  for (const p of planned) {
    if (p.disposition === "retired") {
      summary.retired++;
      summary.perSession.push({ sessionId: p.sessionId, result: "retired" });
      continue;
    }
    if (p.disposition === "superseded") {
      summary.superseded++;
      summary.perSession.push({ sessionId: p.sessionId, result: "superseded" });
      continue;
    }
    const res = resumeSessionEntry(indexDb, catalogueDb, p.sessionId, {
      dryRun: opts.dryRun,
      cmuxBin: opts.cmuxBin,
      bridge,
      focus: opts.focus,
    });
    summary.perSession.push({ sessionId: p.sessionId, result: res.status });
    switch (res.status) {
      case "resumed": summary.resumed++; break;
      case "already-open": summary.alreadyOpen++; break;
      case "not-indexed": summary.notIndexed++; break;
      case "spawn-failed": summary.failed++; break;
      // the shared-bridge gate above already aborts on this, but keep the pass fail-closed if a
      // per-session bridge ever comes back unreadable: count it as a failure, never a spawn.
      case "liveness-unreadable": summary.failed++; break;
    }
  }
  return summary;
}
