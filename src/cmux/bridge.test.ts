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
});
