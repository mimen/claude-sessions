import { test, expect } from "bun:test";
import { openIndex } from "../index/schema.ts";
import { openCatalogue, setCluster, setRole, setResumeId, setCompleted, setArchived } from "../catalogue/db.ts";
import { resumeClusterEntry, planClusterMembers, planPin } from "./resume-cluster.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { Bridge } from "../cmux/bridge.ts";

function catRow(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null,
    role: "pr-agent", resumeCommand: null, project: null, cluster: "pr-watch",
    gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null,
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, ...over,
  };
}

const NOW = "2026-07-09T00:00:00Z";

/** Seed a minimal indexed session row (only the columns resume needs). */
function seedIndex(db: ReturnType<typeof openIndex>, id: string, cwd: string) {
  db.query(
    `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
       fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
     VALUES ($id, 'h', $path, $cwd, $cwd, 'p', $id, $now, $now, 1, 0, 0, 0, $id)`,
  ).run({ $id: id, $path: `/store/${id}.jsonl`, $cwd: cwd, $now: NOW });
}

test("resume-cluster fans out over members; dry-run resumes the closed ones", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    // two cluster members, both closed (empty live bridge in dry-run env → nothing open)
    for (const id of ["ctrl", "worker"]) {
      seedIndex(idx, id, "/tmp");
      setResumeId(cat, id, id, NOW);
      setCluster(cat, id, "pr-watch", NOW);
    }
    setRole(cat, "ctrl", "control", NOW);
    setRole(cat, "worker", "pr-agent", NOW);

    const summary = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true });
    expect(summary.perSession.length).toBe(2);
    // in a test env cmux isn't running, so the bridge is empty → both are "closed" → resumed
    expect(summary.resumed).toBe(2);
    expect(summary.alreadyOpen).toBe(0);
  } finally {
    idx.close();
    cat.close();
  }
});

test("a member that isn't indexed is counted, not fatal", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    setResumeId(cat, "ghost", "ghost", NOW);
    setCluster(cat, "ghost", "pr-watch", NOW); // in catalogue, never indexed
    const summary = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true });
    expect(summary.notIndexed).toBe(1);
    expect(summary.resumed).toBe(0);
  } finally {
    idx.close();
    cat.close();
  }
});

test("completed + archived members are retired, never resumed (ADR-0010)", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    for (const id of ["live", "merged", "closed"]) {
      seedIndex(idx, id, "/tmp");
      setResumeId(cat, id, id, NOW);
      setCluster(cat, id, "pr-watch", NOW);
      setRole(cat, id, "pr-agent", NOW);
    }
    setCompleted(cat, "merged", true, NOW); // a merged PR
    setArchived(cat, "closed", true, NOW); // a closed PR
    const s = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true });
    expect(s.retired).toBe(2);
    expect(s.resumed).toBe(1); // only "live"
    expect(s.perSession.find((p) => p.sessionId === "merged")!.result).toBe("retired");
  } finally {
    idx.close();
    cat.close();
  }
});

test("planClusterMembers: a dead sibling of a LIVE work-unit is superseded, not resumed", () => {
  // the real 12120/12121 case: a fresh LIVE session + a stale dead session, same PR
  const members = [
    { sessionId: "live-12120", row: catRow({ sessionId: "live-12120", resumeId: "live-12120", prRepo: "heroku/dashboard", prNumber: 12120, updatedAt: "2026-07-09" }) },
    { sessionId: "dead-12120", row: catRow({ sessionId: "dead-12120", resumeId: "dead-12120", prRepo: "heroku/dashboard", prNumber: 12120, updatedAt: "2026-07-08" }) },
  ];
  const isLive = (sid: string) => sid === "live-12120";
  const plan = planClusterMembers(members, isLive);
  const byId = new Map(plan.map((p) => [p.sessionId, p.disposition]));
  expect(byId.get("live-12120")).toBe("resume-candidate"); // the live one (resume-session -> already-open)
  expect(byId.get("dead-12120")).toBe("superseded"); // the dead sibling: NOT a duplicate pane
});

test("planClusterMembers: freshest dead session wins an unclaimed unit; older ones supersede", () => {
  const members = [
    { sessionId: "old", row: catRow({ sessionId: "old", prRepo: "r", prNumber: 5, updatedAt: "2026-07-01" }) },
    { sessionId: "new", row: catRow({ sessionId: "new", prRepo: "r", prNumber: 5, updatedAt: "2026-07-08" }) },
  ];
  const plan = planClusterMembers(members, () => false); // neither live
  const byId = new Map(plan.map((p) => [p.sessionId, p.disposition]));
  expect(byId.get("new")).toBe("resume-candidate");
  expect(byId.get("old")).toBe("superseded");
});

test("cluster resume ABORTS (spawns nothing) when liveness is unreadable (ADR-0054)", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    for (const id of ["ctrl", "worker"]) {
      seedIndex(idx, id, "/tmp");
      setResumeId(cat, id, id, NOW);
      setCluster(cat, id, "pr-watch", NOW);
      setRole(cat, id, "pr-agent", NOW);
    }
    // an unreadable bridge: liveness can't be resolved → the whole pass must abort, not fan out
    const unreadable: Bridge = {
      surfaces: [], surfaceToWorkspace: new Map(), workspaceIds: () => [],
      surfacesInWorkspace: () => [], surfaceInfo: () => null, locateSession: () => null,
      isOpen: () => false, primarySurface: () => null, readable: false,
    };
    const s = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true, bridge: unreadable });
    expect(s.abortedUnreadable).toBe(true);
    expect(s.resumed).toBe(0);
    expect(s.perSession.length).toBe(0); // nothing was even planned
  } finally {
    idx.close();
    cat.close();
  }
});

// --- planPin: the pin-by-ref decision (the fix for the "control didn't pin on resume" bug) ---

test("planPin: opted-in role + fresh workspace ref → pins that ref", () => {
  const shouldPin = (role: string | null) => role === "control";
  expect(planPin("control", "workspace:44", shouldPin)).toBe("workspace:44");
});

test("planPin: role not opted in → skip regardless of ref", () => {
  const shouldPin = (role: string | null) => role === "control";
  expect(planPin("pr-agent", "workspace:44", shouldPin)).toBeNull();
});

test("planPin: opted-in role but no ref (spawn missed / bridge lookup miss) → skip; next tick catches it", () => {
  const shouldPin = () => true;
  expect(planPin("control", null, shouldPin)).toBeNull();
});

test("planPin: null role never pins (bare-session backfill safety)", () => {
  const shouldPin = () => true; // even if a caller says "always pin", a role-less row shouldn't
  expect(planPin(null, "workspace:1", (role) => role !== null && shouldPin())).toBeNull();
});

test("empty cluster is a clean no-op", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    const summary = resumeClusterEntry(idx, cat, "nonexistent", { dryRun: true });
    expect(summary.perSession.length).toBe(0);
    expect(summary.resumed).toBe(0);
  } finally {
    idx.close();
    cat.close();
  }
});
