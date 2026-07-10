import { describe, expect, test } from "bun:test";
import { planBump } from "./bump.ts";
import type { Bridge, SurfaceLocation } from "../cmux/bridge.ts";

function surface(over: Partial<SurfaceLocation>): SurfaceLocation {
  return {
    surfaceId: "S", surfaceRef: "surface:1", surfaceType: "terminal", title: null,
    paneId: "P", paneIndex: 0, indexInPane: 0, workspaceId: "W", workspaceRef: "workspace:1",
    workspaceTitle: null, windowId: "WIN", windowRef: "window:1", ...over,
  };
}

/** Bridge stub: maps a sessionId to a live surface (or not). */
function stubBridge(liveSession: string | null, loc?: SurfaceLocation): Bridge {
  return {
    surfaces: loc ? [loc] : [],
    surfaceToWorkspace: new Map(loc ? [[loc.surfaceId, loc]] : []),
    workspaceIds: () => [],
    surfacesInWorkspace: () => [],
    surfaceInfo: () => null,
    locateSession: (id) => (id === liveSession ? loc ?? null : null),
    isOpen: (id) => id === liveSession,
    primarySurface: () => null,
  };
}

describe("planBump", () => {
  test("delivers AND wakes when the recipient session is live", () => {
    const loc = surface({ surfaceRef: "surface:9" });
    const plan = planBump(stubBridge("sess-1", loc), "sess-1");
    expect(plan.deliver).toBe(true); // always deliver (durable)
    expect(plan.wake).toBe(true);
    expect(plan.surfaceRef).toBe("surface:9");
  });

  test("delivers but does NOT wake when the recipient is closed (mail waits)", () => {
    const plan = planBump(stubBridge(null), "sess-closed");
    expect(plan.deliver).toBe(true); // message is durable regardless
    expect(plan.wake).toBe(false);
    expect(plan.surfaceRef).toBeNull();
  });
});
