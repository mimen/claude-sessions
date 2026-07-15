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
  setParent,
  setParked,
} from "./db.ts";
import { describe as dispo } from "./disposition.ts";

/**
 * Post-ADR-0089 v33: catalogue holds only per-run session state. Identity attributes (role,
 * cluster, key, project, gusWork, pr_*, stage, statusLine, groupingId, workUnitId) live on
 * the `identities` table and its per-role sibling tables. Setters for those columns still
 * exist as no-op shims for API stability, but they don't round-trip through catalogue anymore
 * — tests for that behavior lived here pre-refactor and have been deleted.
 *
 * The tests that remain cover the fields catalogue STILL owns: custom_title, lifecycle
 * (completed/archived/parked), parent edge, notes, tags.
 */

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

test("kind is 'session' for a row without a resolvable role", () => {
  // kind derives from role.toml (a role with a resume_command → 'loop'). A row with no
  // linked identity or an unresolvable role name reads as 'session'.
  const db = openCatalogue(":memory:");
  setCustomTitle(db, "s", "solo", NOW);
  expect(getRow(db, "s")!.kind).toBe("session");
});

test("tags: add, list, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  addTag(db, "s1", "Glizzy Galaxy");
  addTag(db, "s1", "Glizzy Galaxy"); // dup ignored
  addTag(db, "s2", "Glizzy Galaxy");
  expect(getTags(db, "s1")).toEqual(["Glizzy Galaxy"]);
  expect(sessionsForEntity(db, "Glizzy Galaxy").sort()).toEqual(["s1", "s2"]);
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
  setCustomTitle(db, "root", "loop-manager", NOW);
  const edges = parentEdges(db).sort((x, y) => x.sessionId.localeCompare(y.sessionId));
  expect(edges).toEqual([
    { sessionId: "a", parentId: "root" },
    { sessionId: "b", parentId: "root" },
  ]);
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

test("catalogue survives reopen (durable file semantics)", () => {
  const db = openCatalogue(":memory:");
  setCustomTitle(db, "s", "keep", NOW);
  const again = openCatalogue(":memory:");
  expect(getRow(again, "s")).toBeNull();
  expect(getRow(db, "s")!.customTitle).toBe("keep");
});

test("v33 schema postcondition passes on a fresh migrated DB", () => {
  const db = openCatalogue(":memory:");
  const cols = db.query("PRAGMA table_info(catalogue)").all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  // Post-v33 required columns:
  expect(names.has("session_id")).toBe(true);
  expect(names.has("identity_key")).toBe(true);
  expect(names.has("meta")).toBe(true);
  expect(names.has("updated_at")).toBe(true);
  // Legacy identity columns are gone:
  expect(names.has("role")).toBe(false);
  expect(names.has("cluster")).toBe(false);
  expect(names.has("pr_number")).toBe(false);
  expect(names.has("gus_work")).toBe(false);
  expect(names.has("key")).toBe(false);
  expect(names.has("stage")).toBe(false);
  expect(names.has("status_line")).toBe(false);
});
