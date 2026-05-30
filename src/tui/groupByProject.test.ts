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
  const items = buildDisplayItems(rows, false, new Set());
  expect(items).toHaveLength(3);
  expect(items.every((i) => i.kind === "session")).toBe(true);
});

test("grouped shows headers; only expanded groups reveal sessions", () => {
  const collapsed = buildDisplayItems(rows, true, new Set());
  expect(collapsed.map((i) => i.kind)).toEqual(["header", "header"]);

  const expanded = buildDisplayItems(rows, true, new Set(["/x"]));
  // header(x), session a, session c, header(y)
  expect(expanded.map((i) => i.kind)).toEqual(["header", "session", "session", "header"]);
});
