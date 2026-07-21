import { describe, expect, test } from "bun:test";
import { getAll, openCatalogue, setParent, setSessionClass } from "../catalogue/db.ts";
import type { SessionRow } from "../index/index.ts";
import { buildTreeItems } from "./treeGroups.ts";

function row(sessionId: string, costUSD: number): SessionRow {
  return {
    sessionId,
    host: "test",
    path: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp",
    projectRoot: "/tmp",
    projectName: "test",
    branch: null,
    version: null,
    firstTs: "2026-07-20T00:00:00Z",
    lastTs: "2026-07-20T00:00:01Z",
    msgCount: 1,
    fileSize: 1,
    title: sessionId,
    titleSource: "fallback",
    isSubagent: false,
    parentSessionId: null,
    resumeId: sessionId,
    costUSD,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: {},
    userTurns: 1,
    tickIntervalSec: 0,
  };
}

describe("buildTreeItems", () => {
  test("keeps a visible parent whose auxiliary child is filtered while retaining rolled-up cost", () => {
    const db = openCatalogue(":memory:");
    try {
      setSessionClass(db, "parent", "work_body", "2026-07-20T00:00:00Z");
      setSessionClass(db, "child", "auxiliary", "2026-07-20T00:00:00Z");
      setParent(db, "child", "parent", "2026-07-20T00:00:00Z");
      const items = buildTreeItems([row("parent", 2)], {
        catMap: getAll(db),
        costOf: () => 9,
      });
      expect(items).toHaveLength(1);
      expect(items[0]?.kind).toBe("session");
      if (items[0]?.kind !== "session") return;
      expect(items[0].row.sessionId).toBe("parent");
      expect(items[0].childCount).toBe(0);
      expect(items[0].subtreeCost).toBe(9);
    } finally {
      db.close();
    }
  });

  test("does not double-count authoritative recursive totals across visible rows", () => {
    const db = openCatalogue(":memory:");
    try {
      setSessionClass(db, "parent", "work_body", "2026-07-20T00:00:00Z");
      setSessionClass(db, "child", "auxiliary", "2026-07-20T00:00:00Z");
      setParent(db, "child", "parent", "2026-07-20T00:00:00Z");
      const totals = new Map([["parent", 9], ["child", 7]]);
      const items = buildTreeItems([row("parent", 2), row("child", 7)], {
        catMap: getAll(db),
        costOf: (session) => totals.get(session.sessionId) ?? session.costUSD,
      });
      const parent = items.find((item) => item.kind === "session" && item.row.sessionId === "parent");
      expect(parent?.kind === "session" ? parent.subtreeCost : null).toBe(9);
    } finally {
      db.close();
    }
  });
});
