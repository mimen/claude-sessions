import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  openCatalogue,
  setRole,
  setCluster,
  stampPrFacts,
  setGusWork,
  deriveIdentityKey,
  getRow,
} from "./db.ts";

const NOW = "2026-07-14T12:00:00Z";

/**
 * ADR-0089 (v32) migration. A fresh openCatalogue(":memory:") stamps directly to v32, which is
 * the "no rows to backfill" path — plenty for confirming the new tables + FK column exist. The
 * "backfill from a v31 fixture" path is exercised by seeding rows, then simulating v32 with a
 * fresh call and asserting identities got minted.
 */

describe("v32 schema", () => {
  test("creates universal tables", () => {
    const db = openCatalogue(":memory:");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toContain("identities");
    expect(tables).toContain("groupings");
    expect(tables).toContain("inboxes");
    expect(tables).toContain("identity_state");
    expect(tables).toContain("dispositions");
    expect(tables).toContain("schema_migrations");
  });

  test("adds identity_key FK column on catalogue", () => {
    const db = openCatalogue(":memory:");
    const cols = (db.query("PRAGMA table_info(catalogue)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("identity_key");
  });

  test("stamps user_version = 32", () => {
    const db = openCatalogue(":memory:");
    const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(32);
  });

  test("indexes exist on identities, groupings, inboxes", () => {
    const db = openCatalogue(":memory:");
    const idx = (db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(idx).toContain("idx_identities_cluster");
    expect(idx).toContain("idx_identities_grouping");
    expect(idx).toContain("idx_inboxes_identity_status");
    expect(idx).toContain("idx_catalogue_identity");
  });
});

describe("v32 identity backfill from catalogue rows", () => {
  /**
   * Simulate a v31→v32 upgrade by seeding a fresh DB at v31 schema, populating rows, then
   * bumping user_version back to 31 and re-opening (which triggers the v32 block). The v32
   * block scans catalogue and mints identities for rows with enough info.
   */
  function seedV31WithRows(rows: Array<Record<string, unknown>>): Database {
    const db = openCatalogue(":memory:"); // already at v32 with empty tables
    // Insert catalogue rows directly, then wipe the identities the fresh-open path created
    // (there aren't any yet — empty DB) and force a re-run by rewinding user_version.
    for (const r of rows) {
      db.query(
        `INSERT INTO catalogue (session_id, role, cluster, pr_repo, pr_number, gus_work,
                                work_unit_id, grouping_id, stage, status_line,
                                completed, archived, meta, updated_at)
         VALUES ($sid, $role, $cluster, $pr_repo, $pr_number, $gus_work,
                 $work_unit_id, $grouping_id, $stage, $status_line,
                 $completed, $archived, $meta, $now)`,
      ).run({
        $sid: r.session_id as string,
        $role: (r.role as string | undefined) ?? null,
        $cluster: (r.cluster as string | undefined) ?? null,
        $pr_repo: (r.pr_repo as string | undefined) ?? null,
        $pr_number: (r.pr_number as number | undefined) ?? null,
        $gus_work: (r.gus_work as string | undefined) ?? null,
        $work_unit_id: (r.work_unit_id as string | undefined) ?? null,
        $grouping_id: (r.grouping_id as string | undefined) ?? null,
        $stage: (r.stage as string | undefined) ?? null,
        $status_line: (r.status_line as string | undefined) ?? null,
        $completed: (r.completed as number | undefined) ?? 0,
        $archived: (r.archived as number | undefined) ?? 0,
        $meta: (r.meta as string | undefined) ?? null,
        $now: NOW,
      });
    }
    // Reset the FK column that fresh-open assigned (there were no rows to see) and rewind so
    // reopening runs the v32 backfill against the seeded rows.
    db.exec("UPDATE catalogue SET identity_key = NULL;");
    db.exec("DELETE FROM identities;");
    db.exec("PRAGMA user_version = 31;");
    return db;
  }

  test("mints one identity for a fleet PR row and links the session", () => {
    const seeded = seedV31WithRows([
      {
        session_id: "sess-1",
        role: "pr-agent",
        cluster: "pr-watch",
        pr_repo: "owner/repo",
        pr_number: 12345,
        stage: "milad-review",
      },
    ]);
    // Reopen forces the migration block to run against the seeded rows.
    const dbPath = ":memory:"; // can't re-open :memory:, so re-run migrate on the same handle
    // Simulate reopen: bump the version back to trigger the block, which openCatalogue() would
    // do — the migrate() function is internal, so we invoke openCatalogue() by wrapping the
    // handle. Instead, close-and-reopen isn't possible with :memory:, so we call migrate again
    // by importing the private function. Cleaner: use a file-backed DB in a temp dir.

    // Reopen via a file-backed DB.
    seeded.close();
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "v32-"));
    try {
      const path = join(tmp, "cat.db");
      const setup = openCatalogue(path);
      setup.query(
        `INSERT INTO catalogue (session_id, role, cluster, pr_repo, pr_number, stage,
                                completed, archived, updated_at, identity_key)
         VALUES ('sess-1', 'pr-agent', 'pr-watch', 'owner/repo', 12345, 'milad-review',
                 0, 0, $now, NULL)`,
      ).run({ $now: NOW });
      setup.exec("DELETE FROM identities;");
      setup.exec("PRAGMA user_version = 31;");
      setup.close();

      // Reopen — triggers the v32 block with seeded row.
      const db = openCatalogue(path);
      const identities = db.query("SELECT * FROM identities").all() as Array<{
        identity_key: string;
        cluster: string;
        role: string;
        kind: string;
        stage: string | null;
      }>;
      expect(identities.length).toBe(1);
      expect(identities[0]!.identity_key).toBe("pr-watch:pr-agent:owner/repo#12345");
      expect(identities[0]!.kind).toBe("fleet");
      expect(identities[0]!.stage).toBe("milad-review");

      const row = getRow(db, "sess-1")!;
      // catalogue.identity_key was populated by the backfill (getRow doesn't expose it yet, so
      // check via raw query).
      const raw = db
        .query("SELECT identity_key FROM catalogue WHERE session_id = 'sess-1'")
        .get() as { identity_key: string };
      expect(raw.identity_key).toBe("pr-watch:pr-agent:owner/repo#12345");
      expect(row.sessionId).toBe("sess-1"); // sanity: session row still exists
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("mints one core identity for a role+cluster row with no work-ref", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "v32-"));
    try {
      const path = join(tmp, "cat.db");
      const setup = openCatalogue(path);
      setup.query(
        `INSERT INTO catalogue (session_id, role, cluster, completed, archived, updated_at, identity_key)
         VALUES ('sess-concierge', 'concierge', 'pr-watch', 0, 0, $now, NULL)`,
      ).run({ $now: NOW });
      setup.exec("DELETE FROM identities;");
      setup.exec("PRAGMA user_version = 31;");
      setup.close();

      const db = openCatalogue(path);
      const identities = db.query("SELECT * FROM identities").all() as Array<{
        identity_key: string;
        kind: string;
      }>;
      expect(identities.length).toBe(1);
      expect(identities[0]!.identity_key).toBe("pr-watch:concierge");
      expect(identities[0]!.kind).toBe("core");
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("leaves a loose session (no role/cluster) unlinked with no identity minted", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "v32-"));
    try {
      const path = join(tmp, "cat.db");
      const setup = openCatalogue(path);
      setup.query(
        `INSERT INTO catalogue (session_id, completed, archived, updated_at, identity_key)
         VALUES ('sess-loose', 0, 0, $now, NULL)`,
      ).run({ $now: NOW });
      setup.exec("DELETE FROM identities;");
      setup.exec("PRAGMA user_version = 31;");
      setup.close();

      const db = openCatalogue(path);
      const identities = db.query("SELECT COUNT(*) as c FROM identities").get() as { c: number };
      expect(identities.c).toBe(0);
      const raw = db
        .query("SELECT identity_key FROM catalogue WHERE session_id = 'sess-loose'")
        .get() as { identity_key: string | null };
      expect(raw.identity_key).toBeNull();
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("deduplicates: two sessions on the same PR share one identity", () => {
    const { mkdtempSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "v32-"));
    try {
      const path = join(tmp, "cat.db");
      const setup = openCatalogue(path);
      const rows = [
        { sid: "sess-a", stage: "milad-review" },
        { sid: "sess-b", stage: "in-review" }, // twin — different stage
      ];
      for (const r of rows) {
        setup.query(
          `INSERT INTO catalogue (session_id, role, cluster, pr_repo, pr_number, stage,
                                  completed, archived, updated_at, identity_key)
           VALUES ($sid, 'pr-agent', 'pr-watch', 'owner/repo', 12345, $stage, 0, 0, $now, NULL)`,
        ).run({ $sid: r.sid, $stage: r.stage, $now: NOW });
      }
      setup.exec("DELETE FROM identities;");
      setup.exec("PRAGMA user_version = 31;");
      setup.close();

      const db = openCatalogue(path);
      const identities = db.query("SELECT COUNT(*) as c FROM identities").all() as { c: number }[];
      expect(identities[0]!.c).toBe(1);
      const linked = db
        .query("SELECT session_id, identity_key FROM catalogue ORDER BY session_id")
        .all() as Array<{ session_id: string; identity_key: string }>;
      expect(linked.map((l) => l.identity_key)).toEqual([
        "pr-watch:pr-agent:owner/repo#12345",
        "pr-watch:pr-agent:owner/repo#12345",
      ]);
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("deriveIdentityKey", () => {
  test("fleet: cluster:role:pr_repo#pr_number", () => {
    expect(
      deriveIdentityKey({
        cluster: "pr-watch",
        role: "pr-agent",
        prRepo: "owner/repo",
        prNumber: 12345,
      }),
    ).toBe("pr-watch:pr-agent:owner/repo#12345");
  });

  test("fleet: cluster:role:gus when no PR", () => {
    expect(
      deriveIdentityKey({
        cluster: "pr-watch",
        role: "pr-agent",
        gusWork: "W-99999999",
      }),
    ).toBe("pr-watch:pr-agent:W-99999999");
  });

  test("fleet: cluster:role:work_unit_id when no PR or GUS", () => {
    expect(
      deriveIdentityKey({
        cluster: "pr-watch",
        role: "pr-agent",
        workUnitId: "wu-abc123",
      }),
    ).toBe("pr-watch:pr-agent:wu-abc123");
  });

  test("core: cluster:role when no work-ref", () => {
    expect(deriveIdentityKey({ cluster: "pr-watch", role: "concierge" })).toBe("pr-watch:concierge");
  });

  test("null when no cluster or no role", () => {
    expect(deriveIdentityKey({ role: "pr-agent" })).toBeNull();
    expect(deriveIdentityKey({ cluster: "pr-watch" })).toBeNull();
    expect(deriveIdentityKey({})).toBeNull();
  });

  test("PR wins over GUS wins over work_unit_id", () => {
    expect(
      deriveIdentityKey({
        cluster: "pr-watch",
        role: "pr-agent",
        prRepo: "owner/repo",
        prNumber: 12345,
        gusWork: "W-99999999",
        workUnitId: "wu-abc",
      }),
    ).toBe("pr-watch:pr-agent:owner/repo#12345");
  });
});
