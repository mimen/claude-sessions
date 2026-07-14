import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDefaultComposer } from "./default-composer.ts";
import { readBoard } from "./paths.ts";
import { openCatalogue, ensureRow, setCluster, setKey, setStage, setStatusLine } from "../catalogue/db.ts";

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

test("default composer produces board from catalogue", () => {
  const cataloguePath = join(tempRoot, "cache", "catalogue.db");
  const db = openCatalogue(cataloguePath);
  ensureRow(db, "aaa", "2026-07-13T00:00:00Z");
  setCluster(db, "aaa", "test-cluster", "2026-07-13T00:00:00Z");
  setKey(db, "aaa", "pr-watch:pr-agent:heroku/dashboard#123", "2026-07-13T00:00:00Z");
  setStage(db, "aaa", "building", "2026-07-13T00:00:00Z");
  setStatusLine(db, "aaa", "running tests", "2026-07-13T00:00:00Z");
  ensureRow(db, "bbb", "2026-07-13T00:00:00Z");
  setCluster(db, "bbb", "test-cluster", "2026-07-13T00:00:00Z");
  setKey(db, "bbb", "pr-watch:pr-agent:heroku/dashboard#456", "2026-07-13T00:00:00Z");
  setStage(db, "bbb", "in review", "2026-07-13T00:00:00Z");
  runDefaultComposer("test-cluster");
  const board = readBoard("test-cluster");
  expect(board).not.toBeNull();
  expect(board?.status).toBe("OK");
  expect(board?.provenance.source).toBe("ccs-default-composer");
  expect(board?.rows.length).toBe(2);
  const row1 = board?.rows.find((r) => r.identity === "pr-watch:pr-agent:heroku/dashboard#123");
  expect(row1).toBeDefined();
  expect(row1?.sessions.length).toBe(1);
  expect(row1?.sessions[0]?.sessionId).toBe("aaa");
  expect(row1?.pills.length).toBe(1);
  expect(row1?.pills[0]?.label).toBe("building");
  expect(row1?.description).toBe("running tests");
  const row2 = board?.rows.find((r) => r.identity === "pr-watch:pr-agent:heroku/dashboard#456");
  expect(row2).toBeDefined();
  expect(row2?.pills[0]?.label).toBe("in review");
});

test("default composer single-row mode merges into existing board", () => {
  const cataloguePath = join(tempRoot, "cache", "catalogue.db");
  const db = openCatalogue(cataloguePath);
  ensureRow(db, "aaa", "2026-07-13T00:00:00Z");
  setCluster(db, "aaa", "test-cluster", "2026-07-13T00:00:00Z");
  setKey(db, "aaa", "pr-watch:pr-agent:heroku/dashboard#123", "2026-07-13T00:00:00Z");
  setStage(db, "aaa", "building", "2026-07-13T00:00:00Z");
  ensureRow(db, "bbb", "2026-07-13T00:00:00Z");
  setCluster(db, "bbb", "test-cluster", "2026-07-13T00:00:00Z");
  setKey(db, "bbb", "pr-watch:pr-agent:heroku/dashboard#456", "2026-07-13T00:00:00Z");
  setStage(db, "bbb", "in review", "2026-07-13T00:00:00Z");
  runDefaultComposer("test-cluster");
  let board = readBoard("test-cluster");
  expect(board?.rows.length).toBe(2);
  setStage(db, "aaa", "approved", "2026-07-13T00:01:00Z");
  runDefaultComposer("test-cluster", { identity: "pr-watch:pr-agent:heroku/dashboard#123" });
  board = readBoard("test-cluster");
  expect(board?.rows.length).toBe(2);
  const row1 = board?.rows.find((r) => r.identity === "pr-watch:pr-agent:heroku/dashboard#123");
  expect(row1?.pills[0]?.label).toBe("approved");
  const row2 = board?.rows.find((r) => r.identity === "pr-watch:pr-agent:heroku/dashboard#456");
  expect(row2?.pills[0]?.label).toBe("in review");
});
