import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { runDefaultComposer } from "./default-composer.ts";
import { readBoard } from "./paths.ts";
import { openCatalogue, ensureRow } from "../catalogue/db.ts";
import { mintIdentity, setIdentityFields } from "../catalogue/identities.ts";

let tempRoot: string;
let origCcsRoot: string | undefined;
let origHome: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "board-test-"));
  origCcsRoot = process.env.CCS_ROOT;
  origHome = process.env.HOME;
  process.env.CCS_ROOT = tempRoot;
  process.env.HOME = tempRoot;
  mkdirSync(join(tempRoot, "cache"), { recursive: true });
});

afterEach(() => {
  if (origCcsRoot !== undefined) process.env.CCS_ROOT = origCcsRoot;
  else delete process.env.CCS_ROOT;
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  rmSync(tempRoot, { recursive: true, force: true });
});

const NOW = "2026-07-13T00:00:00Z";

/** Post-ADR-0089: attach a session to an identity + set stage/status_line on the identity. */
function attach(db: Database, sid: string, identityKey: string, stage?: string, status?: string, now = NOW): void {
  const [cluster, role] = identityKey.split(":");
  mintIdentity(db, identityKey, { cluster: cluster!, role: role! }, now);
  ensureRow(db, sid, now);
  db.query("UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $sid").run({
    $k: identityKey,
    $now: now,
    $sid: sid,
  });
  const attrs: Record<string, unknown> = {};
  if (stage !== undefined) attrs.stage = stage;
  if (status !== undefined) attrs.status_line = status;
  if (Object.keys(attrs).length > 0) {
    try {
      setIdentityFields(db, identityKey, attrs, now);
    } catch {
      // per-role table absent for core roles — universal columns still land via setIdentityFields
    }
  }
}

test("default composer produces board from catalogue", () => {
  const cataloguePath = join(tempRoot, "cache", "catalogue.db");
  const db = openCatalogue(cataloguePath);
  attach(db, "aaa", "test-cluster:pr-agent:heroku/dashboard#123", "building", "running tests");
  attach(db, "bbb", "test-cluster:pr-agent:heroku/dashboard#456", "in review");
  runDefaultComposer("test-cluster");
  const board = readBoard("test-cluster");
  expect(board).not.toBeNull();
  expect(board?.status).toBe("OK");
  expect(board?.provenance.source).toBe("ccs-default-composer");
  expect(board?.rows.length).toBe(2);
  const row1 = board?.rows.find((r) => r.identity === "test-cluster:pr-agent:heroku/dashboard#123");
  expect(row1).toBeDefined();
  expect(row1?.sessions.length).toBe(1);
  expect(row1?.sessions[0]?.sessionId).toBe("aaa");
  expect(row1?.pills.length).toBe(0);
  expect(row1?.description).toBe("running tests");
  const row2 = board?.rows.find((r) => r.identity === "test-cluster:pr-agent:heroku/dashboard#456");
  expect(row2).toBeDefined();
  expect(row2?.pills.length).toBe(0);
});

test("default composer single-row mode merges into existing board", () => {
  const cataloguePath = join(tempRoot, "cache", "catalogue.db");
  const db = openCatalogue(cataloguePath);
  attach(db, "aaa", "test-cluster:pr-agent:heroku/dashboard#123", "building", "initial");
  attach(db, "bbb", "test-cluster:pr-agent:heroku/dashboard#456", "in review", "second");
  runDefaultComposer("test-cluster");
  let board = readBoard("test-cluster");
  expect(board?.rows.length).toBe(2);
  // Update #123's status_line, then single-row recompose.
  setIdentityFields(db, "test-cluster:pr-agent:heroku/dashboard#123", { status_line: "updated" }, "2026-07-13T00:01:00Z");
  runDefaultComposer("test-cluster", { identity: "test-cluster:pr-agent:heroku/dashboard#123" });
  board = readBoard("test-cluster");
  expect(board?.rows.length).toBe(2);
  const row1 = board?.rows.find((r) => r.identity === "test-cluster:pr-agent:heroku/dashboard#123");
  expect(row1?.description).toBe("updated");
  const row2 = board?.rows.find((r) => r.identity === "test-cluster:pr-agent:heroku/dashboard#456");
  expect(row2?.description).toBe("second");
});
