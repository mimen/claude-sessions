import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import { buildCostRollup } from "../index/cost-rollup.ts";
import { aggregateSectionCost } from "./App.tsx";

function row(id: string, costUSD: number): SessionRow {
  return {
    sessionId: id,
    host: "test",
    path: `/tmp/${id}.jsonl`,
    cwd: "/tmp",
    projectRoot: "/tmp",
    projectName: "test",
    branch: null,
    version: null,
    firstTs: null,
    lastTs: null,
    msgCount: 0,
    fileSize: 0,
    title: id,
    titleSource: "fallback",
    isSubagent: false,
    parentSessionId: null,
    resumeId: id,
    costUSD,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: {},
    userTurns: 0,
    tickIntervalSec: 0,
  };
}

test("aggregateSectionCost includes hidden descendants and deduplicates visible descendants", () => {
  const parent = row("parent", 5);
  const child = row("child", 10);
  const rollup = buildCostRollup([parent, child], [{ parentId: "parent", sessionId: "child" }]);

  // Default auxiliary-hidden group: the parent still represents all causal spend.
  expect(aggregateSectionCost([parent], rollup)).toBe(15);
  // Revealing the child does not charge it once through the parent and again directly.
  expect(aggregateSectionCost([parent, child], rollup)).toBe(15);
  // Preserve a self-cost if a future caller passes a row outside this rollup's source query.
  expect(aggregateSectionCost([row("outside", 3)], rollup)).toBe(3);
});
