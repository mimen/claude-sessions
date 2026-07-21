import { describe, expect, test } from "bun:test";
import { openCatalogue, deriveIdentityKey } from "./db.ts";

/**
 * ADR-0089 migration (v32 introduced identities + universal tables; v33 dropped legacy
 * per-session identity columns). The one-shot backfill path that scanned catalogue rows
 * with the pre-v32 shape has been retired now that the columns are gone.
 *
 * These tests cover the invariants that survive: fresh-DB schema shape, index presence, and
 * the pure deriveIdentityKey() helper (used by every consumer that mints an identity).
 */

describe("catalogue schema (post-v33)", () => {
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
    expect(tables).toContain("historical_detached_child_backfills");
  });

  test("catalogue holds identity_key FK + only per-run columns", () => {
    const db = openCatalogue(":memory:");
    const cols = new Set(
      (db.query("PRAGMA table_info(catalogue)").all() as { name: string }[]).map((c) => c.name),
    );
    expect(cols.has("identity_key")).toBe(true);
    // Legacy identity columns are gone:
    expect(cols.has("role")).toBe(false);
    expect(cols.has("cluster")).toBe(false);
    expect(cols.has("pr_number")).toBe(false);
    expect(cols.has("pr_repo")).toBe(false);
    expect(cols.has("gus_work")).toBe(false);
    expect(cols.has("stage")).toBe(false);
    expect(cols.has("status_line")).toBe(false);
    expect(cols.has("key")).toBe(false);
    expect(cols.has("grouping_id")).toBe(false);
    expect(cols.has("work_unit_id")).toBe(false);
    expect(cols.has("project")).toBe(false);
    expect(cols.has("session_class")).toBe(true);
  });

  test("stamps user_version to CATALOGUE_VERSION", () => {
    const db = openCatalogue(":memory:");
    const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    expect(v).toBe(36);
  });

  test("universal indexes exist", () => {
    const db = openCatalogue(":memory:");
    const idx = (db.query("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(idx).toContain("idx_identities_cluster");
    expect(idx).toContain("idx_identities_grouping");
    expect(idx).toContain("idx_inboxes_identity_status");
    expect(idx).toContain("idx_catalogue_identity");
    expect(idx).toContain("idx_catalogue_session_class");
  });
});

describe("deriveIdentityKey", () => {
  test("fleet: cluster:role:pr_repo#pr_number", () => {
    expect(
      deriveIdentityKey({
        cluster: "pr-watch", role: "pr-agent",
        prRepo: "owner/repo", prNumber: 12345,
      }),
    ).toBe("pr-watch:pr-agent:owner/repo#12345");
  });

  test("fleet: cluster:role:gus when no PR", () => {
    expect(
      deriveIdentityKey({ cluster: "pr-watch", role: "pr-agent", gusWork: "W-99999999" }),
    ).toBe("pr-watch:pr-agent:W-99999999");
  });

  test("fleet: cluster:role:work_unit_id when no PR or GUS", () => {
    expect(
      deriveIdentityKey({ cluster: "pr-watch", role: "pr-agent", workUnitId: "wu-abc123" }),
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
        cluster: "pr-watch", role: "pr-agent",
        prRepo: "owner/repo", prNumber: 12345,
        gusWork: "W-99999999", workUnitId: "wu-abc",
      }),
    ).toBe("pr-watch:pr-agent:owner/repo#12345");
  });
});
