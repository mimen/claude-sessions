import { test, expect } from "bun:test";
import { searchRows } from "./search.ts";
import type { SessionRow } from "../index/index.ts";

function row(id: string, title: string, project = "proj"): SessionRow {
  return {
    sessionId: id,
    host: "h",
    path: "/p",
    cwd: "/c",
    projectRoot: "/c",
    projectName: project,
    branch: "main",
    version: "1",
    firstTs: "2026-01-01T00:00:00Z",
    lastTs: "2026-01-01T00:00:00Z",
    msgCount: 1,
    fileSize: 1,
    title,
    titleSource: "codex",
    isSubagent: false,
    parentSessionId: null,
    resumeId: id,
    costUSD: 0, tokInput: 0, tokOutput: 0, tokCacheRead: 0, tokCacheWrite: 0, costByModel: {}, models: [], userTurns: 0, tickIntervalSec: 0,
  };
}

const rows = [
  row("a", "Process YNAB transactions"),
  row("b", "Debug meta ads ROAS"),
  row("c", "Talent suggestions"),
];

test("empty query returns all rows unchanged", () => {
  expect(searchRows(rows, "", new Set()).map((r) => r.sessionId)).toEqual(["a", "b", "c"]);
});

test("name match ranks above content-only match", () => {
  // 'b' matches by title; 'c' matches only by content (FTS) → should come after.
  const out = searchRows(rows, "ROAS", new Set(["c"]));
  expect(out[0]?.sessionId).toBe("b");
  expect(out.map((r) => r.sessionId)).toContain("c");
  expect(out.indexOf(out.find((r) => r.sessionId === "b")!)).toBeLessThan(
    out.indexOf(out.find((r) => r.sessionId === "c")!),
  );
});

test("fuzzy tolerates loose typing", () => {
  const out = searchRows(rows, "ynb", new Set());
  expect(out[0]?.sessionId).toBe("a");
});
