import { test, expect } from "bun:test";
import { groupByProject, buildDisplayItems } from "./groupByProject.ts";
import type { SessionRow } from "../index/index.ts";

function row(id: string, root: string, name: string): SessionRow {
  return {
    sessionId: id, host: "h", path: "/p", cwd: root, projectRoot: root, projectName: name,
    branch: null, version: null, firstTs: null, lastTs: null, msgCount: 0, fileSize: 0,
    title: id, titleSource: "fallback", isSubagent: false, parentSessionId: null,
  };
}

const rows = [
  row("a", "/x", "x"),
  row("b", "/y", "y"),
  row("c", "/x", "x"),
];

test("groups preserve first-seen order and collect sessions", () => {
  const groups = groupByProject(rows);
  expect(groups.map((g) => g.name)).toEqual(["x", "y"]);
  expect(groups[0]!.sessions.map((s) => s.sessionId)).toEqual(["a", "c"]);
});

test("flat display items are all sessions", () => {
  const items = buildDisplayItems(rows, false);
  expect(items).toHaveLength(3);
  expect(items.every((i) => i.kind === "session")).toBe(true);
});

test("grouped shows headers; only expanded groups reveal sessions", () => {
  const collapsed = buildDisplayItems(rows, true);
  expect(collapsed.map((i) => i.kind)).toEqual(["header", "header"]);

  const expanded = buildDisplayItems(rows, true, { expandedGroups: new Set(["/x"]) });
  // header(x), session a, session c, header(y)
  expect(expanded.map((i) => i.kind)).toEqual(["header", "session", "session", "header"]);
});

test("expanding a session inlines its subagent children at depth+1", () => {
  const child1 = { ...row("k1", "/x", "x"), isSubagent: true, parentSessionId: "a" };
  const child2 = { ...row("k2", "/x", "x"), isSubagent: true, parentSessionId: "a" };

  const items = buildDisplayItems(rows, false, {
    expandedSessions: new Set(["a"]),
    childCounts: new Map([["a", 2]]),
    childrenByParent: new Map([["a", [child1, child2]]]),
  });

  // a, (k1, k2 nested), b, c
  expect(items.map((i) => (i.kind === "session" ? i.row.sessionId : "H"))).toEqual([
    "a", "k1", "k2", "b", "c",
  ]);
  const parent = items[0];
  if (parent?.kind !== "session") throw new Error("expected session");
  expect(parent.childCount).toBe(2);
  expect(parent.expanded).toBe(true);
  const kid = items[1];
  if (kid?.kind !== "session") throw new Error("expected session");
  expect(kid.depth).toBe(1);
});
