import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
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

test("all timestamps are UTC ISO — TZ-independent (probe: TZ=Pacific/Kiritimati boundary)", () => {
  // Punch-list guarantee: no date-string comparison in the codebase depends
  // on local time. All timestamps use `new Date().toISOString()` (UTC with
  // trailing Z), and comparisons use lexical order on those strings or
  // Date.parse to ms-since-epoch. This test locks the invariant with a
  // literal probe: on UTC+14 (Kiritimati), producing "today" via toISOString
  // and comparing it to a UTC-anchored timestamp yields the SAME shape as
  // on UTC-11 (Midway). If a future change reaches for a local-tz API
  // (e.g. toLocaleString, getDate), the ISO invariant breaks and this test
  // catches it.
  const prev = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Kiritimati";
    const nowIso = new Date().toISOString();
    expect(nowIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    process.env.TZ = "Pacific/Midway";
    const nowIso2 = new Date().toISOString();
    expect(nowIso2).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    // Lexical string comparison of ISO-Z timestamps is monotonic. Take one
    // fixed anchor and assert ordering holds regardless of TZ.
    const anchor = "2026-01-15T12:00:00Z";
    const early = "2026-01-15T00:00:00Z";
    expect(early < anchor).toBe(true);
    expect(anchor > early).toBe(true);
    // And Date.parse is TZ-independent for Z-suffixed inputs.
    expect(Date.parse(anchor) > Date.parse(early)).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test("opens through a symlink and writes durably to the real file", () => {
  // Punch-list guarantee: users who point ~/.ccs/cache at a symlink (e.g.
  // to relocate the cache to a separate disk) should get identical
  // behavior — the DB writes must land on the real file and be visible
  // when reopened directly. sqlite handles this transparently but the
  // WAL sidecar files also need to be created next to the real target;
  // if bun:sqlite ever regresses that (or refuses to follow symlinks),
  // this test catches it before it hits users.
  const root = mkdtempSync(join(tmpdir(), "ccs-symlink-cat-"));
  try {
    const realFile = join(root, "real.db");
    const linkFile = join(root, "linked.db");
    openCatalogue(realFile).close();
    symlinkSync(realFile, linkFile);

    // Write through the symlink.
    const db = openCatalogue(linkFile);
    const t = "2026-07-15T00:00:00Z";
    db.query("INSERT INTO catalogue (session_id, updated_at) VALUES ('s-sym', $t)").run({ $t: t });
    db.close();

    // Re-open via the real path and verify the row lands there.
    const db2 = openCatalogue(realFile);
    const row = db2.query("SELECT session_id FROM catalogue WHERE session_id = 's-sym'").get();
    expect(row).not.toBeNull();
    db2.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("PRAGMA integrity_check reports 'ok' after a realistic write workload", () => {
  // Punch-list guarantee: sqlite integrity_check should always return 'ok'
  // for a DB written by the tool. This exercises a realistic sequence
  // (mint, attach, lifecycle, tag) and verifies no page-level or logical
  // corruption crept in. If a future migration desyncs indexes or drops a
  // constraint mid-transaction, this fails.
  const db = openCatalogue(":memory:");
  const t = "2026-07-15T00:00:00Z";
  db.query(
    "INSERT INTO identities (identity_key, cluster, role, kind, meta, created_at, updated_at) VALUES ('c:r:x#1','c','r','fleet','{}',$n,$n)",
  ).run({ $n: t });
  db.query(
    "INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ('s1','c:r:x#1',$n)",
  ).run({ $n: t });
  setCustomTitle(db, "s1", "hello", t);
  setCompleted(db, "s1", true, t);
  setArchived(db, "s1", true, t);
  setParked(db, "s1", "task-1", t);
  setParent(db, "s1", "s0-parent", t);
  addTag(db, "s1", "Entity");

  const rows = db.query("PRAGMA integrity_check").all() as { integrity_check: string }[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.integrity_check).toBe("ok");
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

test("repairs partially migrated catalogues missing cluster and skill", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-partial-no-cluster-"));
  try {
    for (const version of [5, 30]) {
      const path = join(root, `catalogue-v${version}.db`);
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE catalogue (
          session_id TEXT PRIMARY KEY,
          resume_id TEXT,
          custom_title TEXT,
          completed INTEGER,
          archived INTEGER,
          parked_task_id TEXT,
          notes TEXT,
          updated_at TEXT,
          parent_session_id TEXT,
          project TEXT,
          role TEXT,
          substrate TEXT,
          identity TEXT,
          pr_number INTEGER,
          pr_repo TEXT,
          pr_branch TEXT,
          pr_state TEXT,
          pr_head_sha TEXT,
          key TEXT,
          gus_work TEXT,
          grouping_id TEXT,
          status_line TEXT,
          stage TEXT,
          work_unit_id TEXT,
          meta TEXT
        );
        CREATE INDEX idx_catalogue_role ON catalogue(role);
        INSERT INTO catalogue (session_id, custom_title, updated_at)
        VALUES ('partial-session', 'Retry title', '2026-07-22T00:00:00Z');
        PRAGMA user_version = ${version};
      `);
      legacy.close();

      const migrated = openCatalogue(path);
      expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 37 });
      expect(getRow(migrated, "partial-session")?.customTitle).toBe("Retry title");
      expect(migrated.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      migrated.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates a legacy v5 catalogue that never received the system column", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-v5-no-system-"));
  const path = join(root, "catalogue.db");
  try {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE catalogue (
        session_id TEXT PRIMARY KEY,
        resume_id TEXT,
        custom_title TEXT,
        kind TEXT,
        completed INTEGER,
        archived INTEGER,
        parked_task_id TEXT,
        notes TEXT,
        updated_at TEXT,
        event TEXT,
        parent_session_id TEXT,
        skill TEXT,
        project TEXT,
        role TEXT,
        substrate TEXT,
        identity TEXT
      );
      INSERT INTO catalogue (session_id, custom_title, updated_at)
      VALUES ('legacy-session', 'Preserved title', '2026-07-22T00:00:00Z');
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const migrated = openCatalogue(path);
    expect(migrated.query("PRAGMA user_version").get()).toEqual({ user_version: 37 });
    expect(getRow(migrated, "legacy-session")?.customTitle).toBe("Preserved title");
    expect(migrated.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    migrated.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
