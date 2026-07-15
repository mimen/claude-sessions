import { test, expect } from "bun:test";
import { openIndex } from "../index/schema.ts";
import { openCatalogue, setResumeId, setCompleted, setArchived } from "../catalogue/db.ts";
import { mintIdentity, completeIdentity, archiveIdentity } from "../catalogue/identities.ts";
import { resumeClusterEntry, planClusterMembers, planPin } from "./resume-cluster.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { Bridge } from "../cmux/bridge.ts";
import type { Database } from "bun:sqlite";

function catRow(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null,
    role: "pr-agent", resumeCommand: null, project: null, cluster: "pr-watch",
    gusWork: null, workUnitId: null, groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null,
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null, identityKey: null, ...over,
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

/** Post-ADR-0089: attach a session to a fresh identity and link the FK. */
function attach(cat: Database, sid: string, cluster: string, role: string, now = NOW): string {
  const key = `${cluster}:${role}`;
  mintIdentity(cat, key, { cluster, role }, now);
  setResumeId(cat, sid, sid, now);
  cat.query("UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $sid").run({
    $k: key,
    $now: now,
    $sid: sid,
  });
  return key;
}

/** An empty-but-READABLE bridge — the test environment has cmux with a contradictory
 * hook store from a real dev session, which trips the live bridge into unreadable. Tests
 * that want to exercise the resume flow supply their own empty bridge. */
const EMPTY_READABLE_BRIDGE: Bridge = {
  surfaces: [], surfaceToWorkspace: new Map(), workspaceIds: () => [],
  surfacesInWorkspace: () => [], surfaceInfo: () => null, locateSession: () => null,
  isOpen: () => false, primarySurface: () => null, readable: true,
};

test("resume-cluster fans out over members; dry-run resumes the closed ones", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  try {
    // two cluster members, both closed (empty live bridge in dry-run env → nothing open)
    seedIndex(idx, "ctrl", "/tmp");
    seedIndex(idx, "worker", "/tmp");
    attach(cat, "ctrl", "pr-watch", "control");
    attach(cat, "worker", "pr-watch", "pr-agent");

    const summary = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true, bridge: EMPTY_READABLE_BRIDGE });
    expect(summary.perSession.length).toBe(2);
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
    // Attach a session to pr-watch identity but DON'T seed the index for it.
    attach(cat, "ghost", "pr-watch", "pr-agent");
    const summary = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true, bridge: EMPTY_READABLE_BRIDGE });
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
    // Three sessions, each with its own identity so lifecycle flips don't cascade.
    seedIndex(idx, "live", "/tmp");
    seedIndex(idx, "merged", "/tmp");
    seedIndex(idx, "closed", "/tmp");
    attach(cat, "live", "pr-watch", "pr-agent");
    // Use different identity keys per row so completing one doesn't affect the others.
    const mergedKey = "pr-watch:pr-agent:merged-ref";
    const closedKey = "pr-watch:pr-agent:closed-ref";
    mintIdentity(cat, mergedKey, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    mintIdentity(cat, closedKey, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    setResumeId(cat, "merged", "merged", NOW);
    setResumeId(cat, "closed", "closed", NOW);
    cat.query("UPDATE catalogue SET identity_key = $k WHERE session_id = $sid").run({ $k: mergedKey, $sid: "merged" });
    cat.query("UPDATE catalogue SET identity_key = $k WHERE session_id = $sid").run({ $k: closedKey, $sid: "closed" });
    // Complete via identity (cascades to attached sessions via the read-side join).
    completeIdentity(cat, mergedKey, NOW);
    archiveIdentity(cat, closedKey, NOW);
    const s = resumeClusterEntry(idx, cat, "pr-watch", { dryRun: true, bridge: EMPTY_READABLE_BRIDGE });
    expect(s.retired).toBe(2);
    expect(s.resumed).toBe(1);
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
    seedIndex(idx, "ctrl", "/tmp");
    seedIndex(idx, "worker", "/tmp");
    attach(cat, "ctrl", "pr-watch", "pr-agent");
    attach(cat, "worker", "pr-watch", "pr-agent");
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

test("planPin: opted-in (cluster, role) + fresh workspace ref → pins that ref", () => {
  const shouldPin = (_c: string | null, role: string | null) => role === "control";
  expect(planPin("pr-watch", "control", "workspace:44", shouldPin)).toBe("workspace:44");
});

test("planPin: role not opted in → skip regardless of ref", () => {
  const shouldPin = (_c: string | null, role: string | null) => role === "control";
  expect(planPin("pr-watch", "pr-agent", "workspace:44", shouldPin)).toBeNull();
});

test("planPin: opted-in role but no ref (spawn missed / bridge lookup miss) → skip; next tick catches it", () => {
  const shouldPin = () => true;
  expect(planPin("pr-watch", "control", null, shouldPin)).toBeNull();
});

test("planPin: null role never pins (bare-session backfill safety)", () => {
  // even if a caller says "always pin", a role-less row shouldn't
  expect(planPin(null, null, "workspace:1", (_c, role) => role !== null)).toBeNull();
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
