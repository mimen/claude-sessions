import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseTree,
  parseHookStore,
  buildBridge,
} from "./bridge";

const FIX = join(import.meta.dir, "__fixtures__");
const tree = JSON.parse(readFileSync(join(FIX, "tree.json"), "utf8"));
const store = JSON.parse(readFileSync(join(FIX, "hook-store.json"), "utf8"));

describe("parseTree", () => {
  const surfaces = parseTree(tree);

  test("maps every surface to exactly one workspace (1:1 up, no orphans)", () => {
    expect(surfaces.length).toBeGreaterThan(0);
    for (const s of surfaces) {
      expect(s.surfaceId).toBeTruthy();
      expect(s.workspaceId).toBeTruthy();
      expect(s.workspaceRef).toMatch(/^workspace:/);
    }
  });

  test("spans all windows (not just the current one)", () => {
    // the audit fixture has 4 windows; a current-window-only parse would miss most
    const windows = new Set(surfaces.map((s) => s.windowRef));
    expect(windows.size).toBeGreaterThan(1);
  });

  test("captures ordering fields for primary-session resolution", () => {
    for (const s of surfaces) {
      expect(typeof s.paneIndex).toBe("number");
      expect(typeof s.indexInPane).toBe("number");
    }
  });
});

describe("parseHookStore", () => {
  const agents = parseHookStore(store);

  test("keys the active surface→session binding by surface UUID", () => {
    expect(agents.size).toBeGreaterThan(0);
    for (const [surfaceId, agent] of agents) {
      expect(surfaceId).toBeTruthy();
      expect(agent.sessionId).toBeTruthy();
    }
  });

  test("enriches each binding with the session detail (workspace, restorable)", () => {
    const withWorkspace = [...agents.values()].filter((a) => a.workspaceId);
    expect(withWorkspace.length).toBeGreaterThan(0);
    expect([...agents.values()].some((a) => a.isRestorable)).toBe(true);
  });

  test("B14: sessions[sid].surfaceId (fresher) wins over stale activeSessionsBySurface", () => {
    // Reattach scenario: session-A used to be on surface-X and cmux left the old byMap binding
    // in place. Session-B is now on surface-X per the fresher sessions[B].surfaceId. The map
    // must resolve surface-X → B (fresh), not A (stale).
    const staleStore = {
      sessions: {
        "session-B": { surfaceId: "surface-X", workspaceId: "ws-1" },
      },
      activeSessionsBySurface: {
        "surface-X": { sessionId: "session-A" },
      },
    };
    const m = parseHookStore(staleStore);
    expect(m.get("surface-X")?.sessionId).toBe("session-B");
  });

  test("B14: contradictions log loudly; sessions view wins (fresher)", () => {
    // The exact reattach shape: both views cover surface-X but with different sessions. The
    // sessions view is the fresher signal (hook fires post-reattach and stamps .surfaceId
    // first). We keep it AND log so operators see the drift. This is the sole difference
    // from the old logic — which trusted activeSessionsBySurface as first-writer.
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => { errs.push(args.map(String).join(" ")); };
    try {
      const contradictoryStore = {
        sessions: {
          "session-A": { surfaceId: "surface-X" },  // fresh: A on X
        },
        activeSessionsBySurface: {
          "surface-X": { sessionId: "session-B" },  // stale: B on X (pre-reattach)
        },
      };
      const m = parseHookStore(contradictoryStore);
      expect(m.get("surface-X")?.sessionId).toBe("session-A"); // fresher wins
      expect(errs.some((e) => e.includes("contradictory hook-store binding"))).toBe(true);
      expect(errs.some((e) => e.includes("session-A".slice(0, 8) + " (KEPT"))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  test("B14: activeSessionsBySurface fills in surfaces the sessions view doesn't cover", () => {
    // Legitimate case: cmux knows surface-Y via activeSessionsBySurface but the sessions
    // entry for session-C hasn't landed yet. The binding must still resolve.
    const partialStore = {
      sessions: {},
      activeSessionsBySurface: {
        "surface-Y": { sessionId: "session-C" },
      },
    };
    const m = parseHookStore(partialStore);
    expect(m.get("surface-Y")?.sessionId).toBe("session-C");
  });
});

describe("buildBridge", () => {
  const bridge = buildBridge(tree, store);

  const agents = parseHookStore(store);
  // pick a binding whose surface is actually live in the tree (the store also holds stale ones)
  const liveEntry = [...agents].find(([surfaceId]) => bridge.surfaceToWorkspace.has(surfaceId));
  if (!liveEntry) throw new Error("fixture has no live claude surface");
  const [firstSurfaceId, firstAgent] = liveEntry;

  test("bridge built from readable sources reports readable=true", () => {
    expect(bridge.readable).toBe(true);
    expect(buildBridge(tree, store, false).readable).toBe(false);
  });

  test("stale bindings (surface not in the tree) do NOT count as open", () => {
    // the fixture seeds 2 bindings whose surfaces are gone; liveness must intersect the tree
    const staleSessions = [...agents.values()]
      .filter((a) => !bridge.surfaceToWorkspace.has(
        [...agents].find(([, v]) => v.sessionId === a.sessionId)![0],
      ))
      .map((a) => a.sessionId);
    expect(staleSessions.length).toBeGreaterThan(0);
    for (const sid of staleSessions) expect(bridge.isOpen(sid)).toBe(false);
  });

  test("resolves a session id to its live surface + workspace", () => {
    const loc = bridge.locateSession(firstAgent.sessionId);
    expect(loc).not.toBeNull();
    expect(loc?.surfaceId).toBe(firstSurfaceId);
    expect(loc?.workspaceRef).toMatch(/^workspace:/);
  });

  test("resolves a surface to its session + resume binding", () => {
    const info = bridge.surfaceInfo(firstSurfaceId);
    expect(info?.sessionId).toBe(firstAgent.sessionId);
  });

  test("a live session is detected as open; an unknown id is not", () => {
    expect(bridge.isOpen(firstAgent.sessionId)).toBe(true);
    expect(bridge.isOpen("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  test("primary session of a workspace is the earliest claude-surface", () => {
    const anyLoc = bridge.locateSession(firstAgent.sessionId);
    expect(anyLoc).not.toBeNull();
    const primary = bridge.primarySurface(anyLoc!.workspaceId);
    expect(primary).toBeTruthy();
    // the primary must itself be a claude-running surface
    expect(bridge.surfaceInfo(primary!.surfaceId)?.sessionId).toBeTruthy();
  });

  test("primary is deterministic: lowest (paneIndex, indexInPane) among claude surfaces", () => {
    for (const wsId of bridge.workspaceIds()) {
      const claudeSurfaces = bridge
        .surfacesInWorkspace(wsId)
        .filter((s) => bridge.surfaceInfo(s.surfaceId)?.sessionId)
        .sort(
          (a, b) =>
            a.paneIndex - b.paneIndex || a.indexInPane - b.indexInPane,
        );
      const primary = bridge.primarySurface(wsId);
      if (claudeSurfaces.length === 0) {
        expect(primary).toBeNull();
      } else {
        expect(primary?.surfaceId).toBe(claudeSurfaces[0]?.surfaceId);
      }
    }
  });

  test("session whose recorded pid is dead is NOT live, even when its surface is still in the tree", () => {
    // Real failure mode observed: cmux workspace still open on ttys002 with the pre-restart
    // control surface, `activeSessionsBySurface` still points at the session, but the actual
    // claude process died without firing the stop hook. Only pid-liveness catches this.
    const phantomTree = {
      windows: [
        {
          id: "win-1",
          ref: "window:1",
          workspaces: [
            {
              id: "ws-still-open",
              ref: "workspace:1",
              panes: [
                {
                  id: "pane-1",
                  ref: "pane:1",
                  index: 0,
                  surfaces: [
                    { id: "surface-still-there", ref: "surface:1", type: "terminal", index_in_pane: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const phantomStore = {
      sessions: {
        "session-dead": { sessionId: "session-dead", surfaceId: "surface-still-there", pid: 999999, agentLifecycle: "running" },
      },
      activeSessionsBySurface: {
        "surface-still-there": { sessionId: "session-dead" },
      },
    };
    const deadPidBridge = buildBridge(phantomTree, phantomStore, true, () => false);
    expect(deadPidBridge.isOpen("session-dead")).toBe(false);
    expect(deadPidBridge.surfaceInfo("surface-still-there")).toBeNull();

    // Sanity: if that same pid IS alive, the session is live (same inputs, only the predicate flips)
    const alivePidBridge = buildBridge(phantomTree, phantomStore, true, () => true);
    expect(alivePidBridge.isOpen("session-dead")).toBe(true);
  });

  test("bindings with no recorded pid pass through (backfill safety: not every session has a pid)", () => {
    const tree2 = {
      windows: [{ id: "w", ref: "window:1", workspaces: [{ id: "ws", ref: "workspace:1", panes: [{ id: "p", ref: "pane:1", index: 0, surfaces: [{ id: "s", ref: "surface:1", type: "terminal", index_in_pane: 0 }] }] }] }],
    };
    const store2 = {
      sessions: { "sid-no-pid": { sessionId: "sid-no-pid", surfaceId: "s" } }, // no pid
      activeSessionsBySurface: { s: { sessionId: "sid-no-pid" } },
    };
    // predicate says nothing is alive, but the binding has no pid → we trust surface-in-tree
    const b = buildBridge(tree2, store2, true, () => false);
    expect(b.isOpen("sid-no-pid")).toBe(true);
  });

  test("session with fresh sessions[sid].surfaceId is live even when activeSessionsBySurface is stale (0.64.17 reattach)", () => {
    // Scenario reproduced from a real fleet resume: cmux `sessions[sid]` was overwritten with the
    // new surface, but `activeSessionsBySurface` still points at the surface the session USED to
    // occupy. The current tree has the new surface, not the old one.
    const reattachTree = {
      windows: [
        {
          id: "win-1",
          ref: "window:1",
          workspaces: [
            {
              id: "ws-new",
              ref: "workspace:2",
              panes: [
                {
                  id: "pane-new",
                  ref: "pane:2",
                  index: 0,
                  surfaces: [
                    { id: "surface-NEW", ref: "surface:2", type: "terminal", index_in_pane: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const reattachStore = {
      sessions: {
        "session-reattached": {
          sessionId: "session-reattached",
          surfaceId: "surface-NEW",
          workspaceId: "ws-new",
          isRestorable: true,
        },
      },
      // Stale byMap: points at the surface the session USED to be on (no longer in the tree)
      activeSessionsBySurface: {
        "surface-OLD-gone": { sessionId: "session-reattached" },
      },
    };
    const reattachBridge = buildBridge(reattachTree, reattachStore);
    expect(reattachBridge.isOpen("session-reattached")).toBe(true);
    expect(reattachBridge.locateSession("session-reattached")?.surfaceId).toBe("surface-NEW");
  });

  test("surface present in tree but unmapped in hook-store is NOT counted as open (ADR-task #9)", () => {
    // Build a minimal fixture: tree with one surface, hook-store with zero bindings
    const unmappedTree = {
      windows: [
        {
          id: "win-1",
          ref: "window:1",
          workspaces: [
            {
              id: "ws-1",
              ref: "workspace:1",
              panes: [
                {
                  id: "pane-1",
                  ref: "pane:1",
                  index: 0,
                  surfaces: [
                    {
                      id: "surface-unmapped",
                      ref: "surface:1",
                      type: "terminal",
                      index_in_pane: 0,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const emptyStore = { sessions: {}, activeSessionsBySurface: {} };
    const testBridge = buildBridge(unmappedTree, emptyStore);

    // The surface is in the tree (readable), but with no hook-store binding it must not count as an open session
    expect(testBridge.surfaces.length).toBe(1);
    expect(testBridge.surfaceInfo("surface-unmapped")).toBeNull();
    expect(testBridge.isOpen("any-session-id")).toBe(false);
    expect(testBridge.primarySurface("ws-1")).toBeNull(); // no claude-running surface → no primary
  });
});
