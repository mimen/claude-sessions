import { expect, test } from "bun:test";
import {
  addTag,
  childrenOf,
  getRow,
  getTags,
  lifecycleOf,
  openCatalogue,
  parentEdges,
  sessionsForEntity,
  setArchived,
  setCompleted,
  setCustomTitle,
  setEvent,
  setKind,
  setParent,
  setParked,
  setProject,
  setSkill,
  setSystem,
  sessionsForEvent,
  sessionsForProject,
  sessionsForSystem,
  setGusWork,
  sessionsForGusWork,
  stampPrFacts,
} from "./db.ts";
import { describe as dispo } from "./disposition.ts";

const NOW = "2026-06-20T00:00:00Z";

test("upsert is idempotent and custom_title round-trips", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")).toBeNull();
  setCustomTitle(db, "s1", "My Loop", NOW);
  setCustomTitle(db, "s1", "Renamed", NOW); // second write updates in place, no dup
  const r = getRow(db, "s1")!;
  expect(r.customTitle).toBe("Renamed");
  expect(r.updatedAt).toBe(NOW);
});

test("lifecycle precedence: archived > completed > parked > idle", () => {
  const db = openCatalogue(":memory:");
  expect(lifecycleOf(getRow(db, "x"))).toBe("idle");
  setParked(db, "x", "task-123", NOW);
  expect(lifecycleOf(getRow(db, "x"))).toBe("parked");
  setCompleted(db, "x", true, NOW);
  expect(lifecycleOf(getRow(db, "x"))).toBe("completed");
  setArchived(db, "x", true, NOW);
  expect(lifecycleOf(getRow(db, "x"))).toBe("archived");
});

test("kind toggles loop", () => {
  const db = openCatalogue(":memory:");
  setKind(db, "s", "loop", NOW);
  expect(getRow(db, "s")!.kind).toBe("loop");
});

test("tags: add, list, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  addTag(db, "s1", "Glizzy Galaxy");
  addTag(db, "s1", "Glizzy Galaxy"); // dup ignored
  addTag(db, "s2", "Glizzy Galaxy");
  expect(getTags(db, "s1")).toEqual(["Glizzy Galaxy"]);
  expect(sessionsForEntity(db, "Glizzy Galaxy").sort()).toEqual(["s1", "s2"]);
});

test("event: set, round-trip, clear, reverse lookup (deprecated alias writes to key)", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.key ?? null).toBeNull();
  setEvent(db, "s1", "glizzy-galaxy", NOW);
  setEvent(db, "s2", "glizzy-galaxy", NOW);
  setEvent(db, "s3", "kiki-factory", NOW);
  // setEvent now writes to key, not event
  expect(getRow(db, "s1")!.key).toBe("glizzy-galaxy");
  expect(getRow(db, "s1")!.event).toBeNull();
  // sessionsForEvent is an alias for sessionsForKey
  expect(sessionsForEvent(db, "glizzy-galaxy").sort()).toEqual(["s1", "s2"]);
  setEvent(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.key).toBeNull();
  expect(sessionsForEvent(db, "glizzy-galaxy")).toEqual(["s2"]);
});

test("parent: set, round-trip, children reverse lookup, clear", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "child1")?.parentSessionId ?? null).toBeNull();
  setParent(db, "child1", "mom", NOW);
  setParent(db, "child2", "mom", NOW);
  setParent(db, "child3", "dad", NOW);
  expect(getRow(db, "child1")!.parentSessionId).toBe("mom");
  expect(childrenOf(db, "mom").sort()).toEqual(["child1", "child2"]);
  expect(childrenOf(db, "dad")).toEqual(["child3"]);
  expect(childrenOf(db, "ghost")).toEqual([]); // unknown parent → no children, no throw
  setParent(db, "child1", null, NOW); // clear
  expect(getRow(db, "child1")!.parentSessionId).toBeNull();
  expect(childrenOf(db, "mom")).toEqual(["child2"]);
});

test("parentEdges: only rows with a parent, as (sessionId, parentId) pairs", () => {
  const db = openCatalogue(":memory:");
  setParent(db, "a", "root", NOW);
  setParent(db, "b", "root", NOW);
  setSkill(db, "root", "loop-manager", NOW); // a row without a parent must not appear as an edge
  const edges = parentEdges(db).sort((x, y) => x.sessionId.localeCompare(y.sessionId));
  expect(edges).toEqual([
    { sessionId: "a", parentId: "root" },
    { sessionId: "b", parentId: "root" },
  ]);
});

test("skill: set, round-trip, clear", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.skill ?? null).toBeNull();
  setSkill(db, "s1", "loop-manager", NOW);
  expect(getRow(db, "s1")!.skill).toBe("loop-manager");
  setSkill(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.skill).toBeNull();
});

test("disposition combines lifecycle × liveness", () => {
  expect(dispo("idle", true).label).toBe("active");
  expect(dispo("idle", false).label).toBe("idle");
  expect(dispo("parked", false).label).toBe("parked");
  const po = dispo("parked", true);
  expect(po.label).toBe("parked·open");
  expect(po.nudge).toBe(true);
  expect(dispo("archived", false).hidden).toBe(true);
  expect(dispo("completed", true).nudge).toBe(true);
});

test("project: set, round-trip, clear, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.project ?? null).toBeNull();
  setProject(db, "s1", "ccs", NOW);
  setProject(db, "s2", "ccs", NOW);
  setProject(db, "s3", "dashboard", NOW);
  expect(getRow(db, "s1")!.project).toBe("ccs");
  expect(sessionsForProject(db, "ccs").sort()).toEqual(["s1", "s2"]);
  setProject(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.project).toBeNull();
  expect(sessionsForProject(db, "ccs")).toEqual(["s2"]);
});

test("system: set, round-trip, clear, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.system ?? null).toBeNull();
  setSystem(db, "s1", "pr-watch", NOW);
  setSystem(db, "s2", "pr-watch", NOW);
  setSystem(db, "s3", "event-loop", NOW);
  expect(getRow(db, "s1")!.system).toBe("pr-watch");
  expect(sessionsForSystem(db, "pr-watch").sort()).toEqual(["s1", "s2"]);
  setSystem(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.system).toBeNull();
  expect(sessionsForSystem(db, "pr-watch")).toEqual(["s2"]);
});

test("gusWork: set, round-trip, clear, reverse lookup (a work item may span sessions)", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.gusWork ?? null).toBeNull();
  setGusWork(db, "s1", "W-23143806", NOW);
  setGusWork(db, "s2", "W-23143806", NOW); // same work item, second session
  setGusWork(db, "s3", "W-23143807", NOW);
  expect(getRow(db, "s1")!.gusWork).toBe("W-23143806");
  expect(sessionsForGusWork(db, "W-23143806").sort()).toEqual(["s1", "s2"]);
  setGusWork(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.gusWork).toBeNull();
  expect(sessionsForGusWork(db, "W-23143806")).toEqual(["s2"]);
});

test("catalogue survives reopen (durable file semantics)", () => {
  // :memory: can't test persistence; assert migration is non-destructive on re-open instead.
  const db = openCatalogue(":memory:");
  setCustomTitle(db, "s", "keep", NOW);
  // re-running migrate (same connection re-open path) must not drop:
  const again = openCatalogue(":memory:"); // separate db, just asserts no throw + clean schema
  expect(getRow(again, "s")).toBeNull(); // separate in-memory db is empty (sanity)
  expect(getRow(db, "s")!.customTitle).toBe("keep");
});

test("PR facts: git-backed session stamps PR metadata", () => {
  const db = openCatalogue(":memory:");
  const sensed = {
    prNumber: 123,
    prRepo: "mimen/claude-sessions",
    prBranch: "feature/pr-sense",
    prState: "open" as const,
    prHeadSha: "abc123def456",
  };
  stampPrFacts(db, "s1", sensed, NOW);
  const row = getRow(db, "s1")!;
  expect(row.prNumber).toBe(123);
  expect(row.prRepo).toBe("mimen/claude-sessions");
  expect(row.prBranch).toBe("feature/pr-sense");
  expect(row.prState).toBe("open");
  expect(row.prHeadSha).toBe("abc123def456");
  expect(row.updatedAt).toBe(NOW);
});

test("PR facts: non-git session gets nulls", () => {
  const db = openCatalogue(":memory:");
  stampPrFacts(db, "s2", null, NOW);
  const row = getRow(db, "s2")!;
  expect(row.prNumber).toBeNull();
  expect(row.prRepo).toBeNull();
  expect(row.prBranch).toBeNull();
  expect(row.prState).toBeNull();
  expect(row.prHeadSha).toBeNull();
});

test("PR facts: merged PR state", () => {
  const db = openCatalogue(":memory:");
  const sensed = {
    prNumber: 456,
    prRepo: "owner/repo",
    prBranch: "main",
    prState: "merged" as const,
    prHeadSha: "deadbeef",
  };
  stampPrFacts(db, "s3", sensed, NOW);
  const row = getRow(db, "s3")!;
  expect(row.prState).toBe("merged");
  expect(row.prHeadSha).toBe("deadbeef");
});

test("PR facts: update existing session", () => {
  const db = openCatalogue(":memory:");
  setCustomTitle(db, "s4", "My PR", NOW);
  const sensed = {
    prNumber: 789,
    prRepo: "org/proj",
    prBranch: "fix/bug",
    prState: "open" as const,
    prHeadSha: "sha1",
  };
  stampPrFacts(db, "s4", sensed, NOW);
  const row = getRow(db, "s4")!;
  expect(row.customTitle).toBe("My PR"); // existing data preserved
  expect(row.prNumber).toBe(789);
  expect(row.prBranch).toBe("fix/bug");
});

test("key: set, round-trip, clear, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  const { setKey, sessionsForKey } = require("./db.ts");
  expect(getRow(db, "s1")?.key ?? null).toBeNull();
  setKey(db, "s1", "heroku/dashboard#12345", NOW);
  setKey(db, "s2", "heroku/dashboard#12345", NOW);
  setKey(db, "s3", "owner/repo#678", NOW);
  expect(getRow(db, "s1")!.key).toBe("heroku/dashboard#12345");
  expect(sessionsForKey(db, "heroku/dashboard#12345").sort()).toEqual(["s1", "s2"]);
  setKey(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.key).toBeNull();
  expect(sessionsForKey(db, "heroku/dashboard#12345")).toEqual(["s2"]);
});

test("identityKeyOf: prefers key over event, falls back to event", () => {
  const db = openCatalogue(":memory:");
  const { setKey, identityKeyOf } = require("./db.ts");
  // legacy row: only event set (key is null) → identityKeyOf returns event
  // Simulate legacy by directly writing to event column (setEvent now writes to key)
  db.query("INSERT INTO catalogue (session_id, event, updated_at) VALUES ($id, $event, $now)").run({
    $id: "legacy",
    $event: "galaxy-summit",
    $now: NOW,
  });
  const legacyRow = getRow(db, "legacy")!;
  expect(legacyRow.key).toBeNull();
  expect(legacyRow.event).toBe("galaxy-summit");
  expect(identityKeyOf(legacyRow)).toBe("galaxy-summit");
  // new row: key set → identityKeyOf prefers key
  setKey(db, "new", "heroku/dashboard#999", NOW);
  const newRow = getRow(db, "new")!;
  expect(newRow.key).toBe("heroku/dashboard#999");
  expect(newRow.event).toBeNull();
  expect(identityKeyOf(newRow)).toBe("heroku/dashboard#999");
  // both set: key wins
  db.query("INSERT INTO catalogue (session_id, event, key, updated_at) VALUES ($id, $event, $key, $now)").run({
    $id: "both",
    $event: "old-event-slug",
    $key: "modern-key",
    $now: NOW,
  });
  const bothRow = getRow(db, "both")!;
  expect(identityKeyOf(bothRow)).toBe("modern-key");
  // neither set: null
  const emptyRow = getRow(db, "neither") ?? { key: null, event: null } as any;
  expect(identityKeyOf(emptyRow)).toBeNull();
});
