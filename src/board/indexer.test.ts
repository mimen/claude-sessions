import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { boardIndex } from "./indexer.ts";
import { boardPath, writeBoard } from "./paths.ts";
import type { Board } from "./types.ts";
import { openCatalogue, ensureRow, setCluster, setKey } from "../catalogue/db.ts";

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

test("indexer builds correct identity map", () => {
  const board: Board = {
    status: "OK",
    provenance: { source: "test", at: "2026-07-13T00:00:00Z" },
    rows: [
      {
        identity: "pr-watch:pr-agent:heroku/dashboard#123",
        workUnit: { kind: "pr", number: 123 },
        sessions: [{ sessionId: "aaa", isPrimary: true, lastActivity: "2026-07-13T00:00:00Z" }],
        pills: [{ key: "ccs_lifecycle", label: "building", priority: 50 }],
        description: null,
        alerts: [],
        awaitingFrom: [],
        lastComposed: "2026-07-13T00:00:00Z",
      },
      {
        identity: "pr-watch:pr-agent:heroku/dashboard#456",
        workUnit: { kind: "pr", number: 456 },
        sessions: [{ sessionId: "bbb", isPrimary: true, lastActivity: "2026-07-13T00:00:00Z" }],
        pills: [{ key: "ccs_lifecycle", label: "in review", priority: 50 }],
        description: null,
        alerts: [],
        awaitingFrom: [],
        lastComposed: "2026-07-13T00:00:00Z",
      },
    ],
  };
  writeBoard("test-cluster", board);
  const idx = boardIndex("test-cluster");
  const row1 = idx.byIdentity("pr-watch:pr-agent:heroku/dashboard#123");
  expect(row1).not.toBeNull();
  expect(row1?.pills[0]?.label).toBe("building");
  const row2 = idx.byIdentity("pr-watch:pr-agent:heroku/dashboard#456");
  expect(row2).not.toBeNull();
  expect(row2?.pills[0]?.label).toBe("in review");
  const missing = idx.byIdentity("nonexistent");
  expect(missing).toBeNull();
});

test("indexer bySession uses session map", () => {
  const board: Board = {
    status: "OK",
    provenance: { source: "test", at: "2026-07-13T00:00:00Z" },
    rows: [
      {
        identity: "pr-watch:pr-agent:heroku/dashboard#123",
        workUnit: { kind: "pr", number: 123 },
        sessions: [{ sessionId: "aaa", isPrimary: true, lastActivity: "2026-07-13T00:00:00Z" }],
        pills: [{ key: "ccs_lifecycle", label: "building", priority: 50 }],
        description: null,
        alerts: [],
        awaitingFrom: [],
        lastComposed: "2026-07-13T00:00:00Z",
      },
    ],
  };
  writeBoard("test-cluster", board);
  const idx = boardIndex("test-cluster");
  const hit = idx.bySession("aaa");
  expect(hit).not.toBeNull();
  expect(hit?.identity).toBe("pr-watch:pr-agent:heroku/dashboard#123");
  expect(hit?.row.pills[0]?.label).toBe("building");
});

test("indexer bySession falls back to catalogue when session not in board", () => {
  const cataloguePath = join(tempRoot, "cache", "catalogue.db");
  const db = openCatalogue(cataloguePath);
  // ADR-0089 v33: attach the session to the identity via FK, not via legacy setters.
  const { mintIdentity } = require("../catalogue/identities.ts");
  const key = "pr-watch:pr-agent:heroku/dashboard#789";
  mintIdentity(db, key, { cluster: "test-cluster", role: "pr-agent" }, "2026-07-13T00:00:00Z");
  ensureRow(db, "ccc", "2026-07-13T00:00:00Z");
  db.query("UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $sid").run({
    $k: key,
    $now: "2026-07-13T00:00:00Z",
    $sid: "ccc",
  });
  const board: Board = {
    status: "OK",
    provenance: { source: "test", at: "2026-07-13T00:00:00Z" },
    rows: [
      {
        identity: "pr-watch:pr-agent:heroku/dashboard#789",
        workUnit: { kind: "pr", number: 789 },
        sessions: [],
        pills: [{ key: "ccs_lifecycle", label: "approved", priority: 50 }],
        description: null,
        alerts: [],
        awaitingFrom: [],
        lastComposed: "2026-07-13T00:00:00Z",
      },
    ],
  };
  writeBoard("test-cluster", board);
  const idx = boardIndex("test-cluster");
  const hit = idx.bySession("ccc");
  expect(hit).not.toBeNull();
  expect(hit?.identity).toBe("pr-watch:pr-agent:heroku/dashboard#789");
  expect(hit?.row.pills[0]?.label).toBe("approved");
});

test("indexer invalidates equal-size replacements with the same mtime", () => {
  const board1: Board = {
    status: "OK",
    provenance: { source: "test", at: "2026-07-13T00:00:00Z" },
    rows: [
      {
        identity: "pr-watch:pr-agent:heroku/dashboard#123",
        workUnit: { kind: "pr", number: 123 },
        sessions: [{ sessionId: "aaa", isPrimary: true, lastActivity: "2026-07-13T00:00:00Z" }],
        pills: [{ key: "ccs_lifecycle", label: "building", priority: 50 }],
        description: null,
        alerts: [],
        awaitingFrom: [],
        lastComposed: "2026-07-13T00:00:00Z",
      },
    ],
  };
  const path = boardPath("test-cluster");
  const fixedTime = new Date("2026-07-13T00:00:00Z");
  writeBoard("test-cluster", board1);
  utimesSync(path, fixedTime, fixedTime);
  const firstStat = statSync(path);

  const idx = boardIndex("test-cluster");
  expect(idx.byIdentity("pr-watch:pr-agent:heroku/dashboard#123")?.pills[0]?.label).toBe("building");

  const board2: Board = {
    ...board1,
    rows: [
      {
        ...board1.rows[0]!,
        pills: [{ key: "ccs_lifecycle", label: "approved", priority: 50 }],
      },
    ],
  };
  writeBoard("test-cluster", board2);
  utimesSync(path, fixedTime, fixedTime);
  const secondStat = statSync(path);

  expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  expect(secondStat.size).toBe(firstStat.size);
  expect(idx.byIdentity("pr-watch:pr-agent:heroku/dashboard#123")?.pills[0]?.label).toBe("approved");
});

test("indexer missing file returns null", () => {
  const idx = boardIndex("nonexistent-cluster");
  expect(idx.byIdentity("anything")).toBeNull();
  expect(idx.bySession("anything")).toBeNull();
  expect(idx.rows()).toEqual([]);
});
