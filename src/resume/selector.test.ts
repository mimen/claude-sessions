import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openCatalogue } from "../catalogue/db.ts";
import { mintIdentity, setIdentityFields } from "../catalogue/identities.ts";
import { upsertGrouping } from "../state/groupings-db.ts";
import { resolveSelector } from "./selector.ts";

const NOW = "2026-07-10T00:00:00Z";

/**
 * Post-ADR-0089: tests seed identities + link sessions via `catalogue.identity_key`. The
 * selector queries the identities table via the joined lookups (sessionsForRole/PR/etc.),
 * so the seed shape has to match.
 */
function seed(): { cat: Database; idx: Database } {
  const cat = openCatalogue(":memory:");
  const idx = new Database(":memory:");
  idx.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, resume_id TEXT)");
  return { cat, idx };
}

function attachSession(db: Database, sid: string, identityKey: string): void {
  db.query(
    `INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)
     ON CONFLICT(session_id) DO UPDATE SET identity_key = $k, updated_at = $now`,
  ).run({ $sid: sid, $k: identityKey, $now: NOW });
}

function stampPr(db: Database, sid: string, repo: string, num: number): void {
  const key = `pr-watch:pr-agent:${repo}#${num}`;
  mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
  try {
    setIdentityFields(db, key, { pr_repo: repo, pr_number: num }, NOW);
  } catch {
    // per-role table absent (:memory: without config root) — skip; selector's PR query
    // needs it though, so the tests that hit that path add a real fixture.
  }
  attachSession(db, sid, key);
}

function stampGus(db: Database, sid: string, w: string): void {
  const key = `pr-watch:pr-agent:${w}`;
  mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
  try {
    setIdentityFields(db, key, { gus_work: w }, NOW);
  } catch {
    // per-role table absent
  }
  attachSession(db, sid, key);
}

function stampRole(db: Database, sid: string, cluster: string, role: string): void {
  const key = `${cluster}:${role}`;
  mintIdentity(db, key, { cluster, role }, NOW);
  attachSession(db, sid, key);
}

/** Materialize identity_pr_agent when the test needs per-role columns. */
function withPrAgentSchema(): void {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const root = mkdtempSync(join(tmpdir(), "ccs-sel-cfg-"));
  const dir = join(root, "clusters", "pr-watch", "roles", "pr-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'kind = "session"\nwork_unit = "pr"\n');
  writeFileSync(
    join(dir, "identity-schema.toml"),
    '[columns]\npr_repo = { type = "text" }\npr_number = { type = "integer", indexed = true }\ngus_work = { type = "text", indexed = true }\n',
  );
  process.env.CCS_CONFIG_ROOT = root;
}

test("PR selector: `owner/repo#123` matches that repo's PR sessions", () => {
  withPrAgentSchema();
  const { cat, idx } = seed();
  stampPr(cat, "s1", "heroku/dashboard", 123);
  stampPr(cat, "s2", "other/repo", 123);
  const r = resolveSelector(cat, idx, "heroku/dashboard#123")!;
  expect(r.kind).toBe("pr");
  expect(r.sessionIds).toEqual(["s1"]);
});

test("PR selector: bare `#123` matches the number across repos", () => {
  withPrAgentSchema();
  const { cat, idx } = seed();
  stampPr(cat, "s1", "a/b", 123);
  stampPr(cat, "s2", "c/d", 123);
  const r = resolveSelector(cat, idx, "#123")!;
  expect(r.kind).toBe("pr");
  expect(r.sessionIds.sort()).toEqual(["s1", "s2"]);
});

test("GUS work item selector (W-number, case-insensitive)", () => {
  withPrAgentSchema();
  const { cat, idx } = seed();
  stampGus(cat, "s1", "W-1234567");
  const r = resolveSelector(cat, idx, "w-1234567")!;
  expect(r.kind).toBe("gus-work");
  expect(r.sessionIds).toEqual(["s1"]);
});

test("role selector (inferred from a bare word not matching a cluster)", () => {
  const { cat, idx } = seed();
  stampRole(cat, "s1", "any-cluster", "control");
  stampRole(cat, "s2", "any-cluster", "control");
  const r = resolveSelector(cat, idx, "control")!;
  expect(r.kind).toBe("role");
  expect(r.sessionIds.sort()).toEqual(["s1", "s2"]);
});

test("cluster wins over role when a bare word is a known cluster (fixed probe order)", () => {
  const { cat, idx } = seed();
  stampRole(cat, "s1", "pr-watch", "some-role");
  stampRole(cat, "s2", "other", "pr-watch"); // pathological: a role named like the cluster
  const r = resolveSelector(cat, idx, "pr-watch")!;
  expect(r.kind).toBe("cluster");
  expect(r.sessionIds).toContain("s1");
});

test("--role pin skips inference even when the token also names a cluster", () => {
  const { cat, idx } = seed();
  stampRole(cat, "s1", "pr-watch", "some-role");
  stampRole(cat, "s2", "other", "pr-watch");
  const r = resolveSelector(cat, idx, "pr-watch", { pin: "role" })!;
  expect(r.kind).toBe("role");
  expect(r.sessionIds).toEqual(["s2"]);
});

test("session-id selector returns the id itself (even if not yet indexed)", () => {
  const { cat, idx } = seed();
  const uuid = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
  const r = resolveSelector(cat, idx, uuid)!;
  expect(r.kind).toBe("session-id");
  expect(r.sessionIds).toEqual([uuid]);
});

test("unmatched token returns null", () => {
  const { cat, idx } = seed();
  expect(resolveSelector(cat, idx, "nothing-matches-this")).toBeNull();
});

test("epic selector resolves a shortname to its grouping's sessions", () => {
  const root = process.env.CCS_ROOT;
  const { mkdtempSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const tmp = mkdtempSync(join(tmpdir(), "ccs-sel-"));
  process.env.CCS_ROOT = tmp;
  try {
    const { cat, idx } = seed();
    const key = "pr-watch:pr-agent:o/r#1";
    mintIdentity(cat, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    try {
      setIdentityFields(cat, key, { grouping_id: "e-42" }, NOW);
    } catch {
      // universal column — should always work
    }
    attachSession(cat, "s1", key);
    upsertGrouping(cat, "e-42", { cluster: "pr-watch", role: "pr-agent", label: "FY27 Metered Pricing", shortName: "Metered" }, NOW);
    const r = resolveSelector(cat, idx, "Metered", { cluster: "pr-watch" })!;
    expect(r.kind).toBe("epic");
    expect(r.sessionIds).toEqual(["s1"]);
  } finally {
    root === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = root);
    rmSync(tmp, { recursive: true, force: true });
  }
});
