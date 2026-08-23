import { expect, test } from "bun:test";
import {
  projectSidebar,
  type IndexedSessionInput,
  type SidebarLifecycle,
  type SidebarView,
} from "./projection.ts";

function indexed(id: string): IndexedSessionInput {
  return {
    sessionId: id,
    resumeId: `${id}-resume`,
    title: id,
    cwd: "/repo",
    lastTs: "2026-08-22T00:00:00.000Z",
    models: [],
    costByModel: {},
  };
}

function snapshot(view: SidebarView, lifecycle: SidebarLifecycle, options: {
  readonly includeT3?: boolean;
  readonly t3Only?: boolean;
} = {}) {
  const row = indexed("t3-session");
  return projectSidebar({
    live: [],
    indexed: [row],
    lifecycles: new Map([
      [row.sessionId, lifecycle],
      [row.resumeId, lifecycle],
    ]),
    canonicalSessionIds: new Map([
      [row.sessionId, row.sessionId],
      [row.resumeId, row.sessionId],
    ]),
    t3AssociatedSessionIds: new Set([row.sessionId, row.resumeId]),
    scope: view === "t3" ? "active" : view as SidebarLifecycle,
    t3Only: options.t3Only ?? view === "t3",
    includeT3: options.includeT3,
    includeLifecycles: lifecycle === "active" ? [] : [lifecycle],
    checkouts: new Map(),
    livenessReadable: true,
    now: Date.parse("2026-08-22T00:00:00.000Z"),
    historyLimit: 10,
    recentLimit: 10,
  });
}

test("ordinary T3 sessions leave Active and appear in the T3 view", () => {
  expect(snapshot("active", "active").rows).toEqual([]);
  const rows = snapshot("t3", "active").rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "t3-session", t3Associated: true, lifecycle: "active" });
});

test("saved and completed T3 sessions overlap their lifecycle and T3 views", () => {
  for (const lifecycle of ["saved", "completed"] as const) {
    expect(snapshot(lifecycle, lifecycle).rows).toHaveLength(1);
    expect(snapshot("t3", lifecycle).rows).toHaveLength(1);
    expect(snapshot("active", lifecycle).rows).toEqual([]);
  }
});

test("a live incognito T3 session remains reachable in the Incognito view", () => {
  const row = indexed("private-t3");
  const result = projectSidebar({
    live: [{
      sessionId: row.sessionId,
      workspaceId: "workspace-1",
      workspaceRef: "workspace:1",
      windowId: "window-1",
      windowRef: "window:1",
      workspaceTitle: "Private T3",
      pinned: false,
      shortcut: null,
      focused: false,
      cwd: "/repo",
      status: null,
      statusAvailability: "absent",
      updatedAt: null,
    }],
    indexed: [row],
    lifecycles: new Map([[row.sessionId, "active"]]),
    t3AssociatedSessionIds: new Set([row.sessionId, row.resumeId]),
    incognitoSessionIds: new Set([row.sessionId, row.resumeId]),
    scope: "active",
    incognitoOnly: true,
    checkouts: new Map(),
    livenessReadable: true,
    now: Date.parse("2026-08-22T00:00:00.000Z"),
  });
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({ id: "private-t3", section: "incognito", t3Associated: true });
});

test("global-search inclusion can mix T3 rows back into Active", () => {
  const rows = snapshot("active", "active", { includeT3: true }).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "t3-session", t3Associated: true });
});
