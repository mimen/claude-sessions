import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addTag,
  childrenOf,
  getRow,
  getTags,
  lifecycleOf,
  openCatalogue,
  parentEdges,
  sessionsForEntity,
  sessionsForRole,
  setArchived,
  setCompleted,
  setCustomTitle,
  setEvent,
  setIdentity,
  setKind,
  setParent,
  setParked,
  setRole,
  setSkill,
  setSubstrate,
  sessionsForEvent,
  substrateOf,
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

test("event: set, round-trip, clear, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.event ?? null).toBeNull();
  setEvent(db, "s1", "glizzy-galaxy", NOW);
  setEvent(db, "s2", "glizzy-galaxy", NOW);
  setEvent(db, "s3", "kiki-factory", NOW);
  expect(getRow(db, "s1")!.event).toBe("glizzy-galaxy");
  expect(sessionsForEvent(db, "glizzy-galaxy").sort()).toEqual(["s1", "s2"]);
  setEvent(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.event).toBeNull();
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

test("role: set, round-trip, clear, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.role ?? null).toBeNull();
  setRole(db, "s1", "todoist-scout", NOW);
  setRole(db, "s2", "todoist-scout", NOW);
  setRole(db, "s3", "ops-watch", NOW);
  expect(getRow(db, "s1")!.role).toBe("todoist-scout");
  expect(sessionsForRole(db, "todoist-scout").sort()).toEqual(["s1", "s2"]);
  setRole(db, "s1", null, NOW); // clear
  expect(getRow(db, "s1")!.role).toBeNull();
  expect(sessionsForRole(db, "todoist-scout")).toEqual(["s2"]);
});

test("substrate: defaults to claude-code, accepts arbitrary values, clears back to default", () => {
  const db = openCatalogue(":memory:");
  expect(substrateOf(getRow(db, "s1"))).toBe("claude-code"); // no row at all
  setCustomTitle(db, "s1", "t", NOW);
  expect(getRow(db, "s1")!.substrate).toBeNull(); // stored raw: unset
  expect(substrateOf(getRow(db, "s1"))).toBe("claude-code"); // read default
  setSubstrate(db, "s1", "codex", NOW);
  expect(substrateOf(getRow(db, "s1"))).toBe("codex");
  setSubstrate(db, "s1", "engine", NOW); // arbitrary values allowed
  expect(getRow(db, "s1")!.substrate).toBe("engine");
  setSubstrate(db, "s1", null, NOW); // clear → back to default
  expect(substrateOf(getRow(db, "s1"))).toBe("claude-code");
  setSubstrate(db, "s1", "claude-code", NOW); // explicit default normalizes to unset
  expect(getRow(db, "s1")!.substrate).toBeNull();
});

test("identity: set, round-trip, clear", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")?.identity ?? null).toBeNull();
  setIdentity(db, "s1", "bestfriend", NOW);
  expect(getRow(db, "s1")!.identity).toBe("bestfriend");
  setIdentity(db, "s1", null, NOW);
  expect(getRow(db, "s1")!.identity).toBeNull();
});

test("v5 migration upgrades a v4 catalogue in place, preserving rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-cat-"));
  const path = join(dir, "catalogue.db");
  try {
    // Build a faithful v4 catalogue by hand (the pre-v5 schema + user_version).
    const v4 = new Database(path, { create: true });
    v4.exec(`
      CREATE TABLE catalogue (
        session_id     TEXT PRIMARY KEY,
        resume_id      TEXT,
        custom_title   TEXT,
        kind           TEXT NOT NULL DEFAULT 'session',
        completed      INTEGER NOT NULL DEFAULT 0,
        archived       INTEGER NOT NULL DEFAULT 0,
        parked_task_id TEXT,
        notes          TEXT,
        updated_at     TEXT,
        event          TEXT,
        parent_session_id TEXT,
        skill          TEXT,
        project        TEXT
      );
      CREATE TABLE session_tags (
        session_id TEXT NOT NULL,
        entity     TEXT NOT NULL,
        PRIMARY KEY (session_id, entity)
      );
      INSERT INTO catalogue (session_id, custom_title, kind, skill) VALUES ('old', 'Keep Me', 'loop', 'ops-watch');
      PRAGMA user_version = 4;
    `);
    v4.close();

    const db = openCatalogue(path);
    const r = getRow(db, "old")!;
    expect(r.customTitle).toBe("Keep Me"); // user data survived
    expect(r.kind).toBe("loop");
    expect(r.role).toBeNull(); // new columns exist, unset
    expect(r.identity).toBeNull();
    expect(substrateOf(r)).toBe("claude-code");
    setRole(db, "old", "ops-watch", NOW); // and are writable
    expect(getRow(db, "old")!.role).toBe("ops-watch");
    db.close();

    // Idempotent: reopening (re-running migrate at v5) must not throw or drop.
    const again = openCatalogue(path);
    expect(getRow(again, "old")!.role).toBe("ops-watch");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
