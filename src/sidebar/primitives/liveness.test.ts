import { describe, expect, test } from "bun:test";
import { joinLiveness, type LivenessRead } from "./liveness.ts";
import type { HookBindingsRead, HookSessionEntry } from "./hook-bindings.ts";
import type { SurfaceTreeRead } from "./surface-tree.ts";
import type { SurfaceLocation } from "../../cmux/bridge.ts";

function loc(overrides: Partial<SurfaceLocation> & Pick<SurfaceLocation, "surfaceId" | "workspaceId">): SurfaceLocation {
  return {
    surfaceRef: "s:1",
    surfaceType: "terminal",
    title: "tab",
    paneId: "p",
    paneIndex: 0,
    indexInPane: 0,
    workspaceRef: "workspace:1",
    workspaceTitle: "Alpha",
    windowId: "w",
    windowRef: "window:1",
    ...overrides,
  };
}

function tree(surfaces: SurfaceLocation[], revision = 1): SurfaceTreeRead {
  return {
    surfaces,
    workspaceIds: new Set(surfaces.map((s) => s.workspaceId)),
    focusedWorkspaceId: surfaces.find((s) => s.workspaceSelected)?.workspaceId ?? null,
    readable: true,
    revision,
  };
}

function entry(overrides: Partial<HookSessionEntry> & Pick<HookSessionEntry, "sessionId">): HookSessionEntry {
  return {
    surfaceId: null,
    agentLifecycle: "running",
    pid: 1,
    transcriptPath: null,
    ...overrides,
  };
}

function bindings(opts: {
  sessions: HookSessionEntry[];
  pid?: Record<string, boolean>;
  tx?: Record<string, "present" | "renamed" | "absent">;
  revision?: number;
  readable?: boolean;
}): HookBindingsRead {
  const sessions = new Map(opts.sessions.map((s) => [s.sessionId, s]));
  const bindingsBySurface = new Map<string, string>();
  for (const s of opts.sessions) if (s.surfaceId) bindingsBySurface.set(s.surfaceId, s.sessionId);
  return {
    bindingsBySurface,
    sessions,
    pidLiveness: new Map(Object.entries(opts.pid ?? {})),
    transcriptPresence: new Map(Object.entries(opts.tx ?? {})),
    readable: opts.readable ?? true,
    revision: opts.revision ?? 1,
  };
}

describe("joinLiveness", () => {
  test("a bound surface in the tree is live, in tree order", () => {
    const sA = loc({ surfaceId: "S-A", workspaceId: "W-A", workspaceRef: "workspace:1" });
    const sB = loc({ surfaceId: "S-B", workspaceId: "W-B", workspaceRef: "workspace:2", workspaceSelected: true });
    const joined = joinLiveness(
      tree([sA, sB], 3),
      bindings({
        sessions: [
          entry({ sessionId: "b", surfaceId: "S-B" }),
          entry({ sessionId: "a", surfaceId: "S-A" }),
        ],
        tx: { a: "present", b: "present" },
      }),
    );
    expect(joined.live.map((r) => r.sessionId)).toEqual(["a", "b"]);
    expect(joined.live[1]?.workspaceFocused).toBe(true);
    expect(joined.ghosts).toEqual([]);
    expect(joined.revision).toBe(3);
  });

  test("a hook-store session whose surface is gone is a ghost", () => {
    const joined = joinLiveness(
      tree([loc({ surfaceId: "S-LIVE", workspaceId: "W" })]),
      bindings({
        sessions: [
          entry({ sessionId: "live", surfaceId: "S-LIVE" }),
          entry({ sessionId: "dead", surfaceId: "S-GONE", agentLifecycle: "running", pid: 9 }),
        ],
        pid: { dead: false },
        tx: { live: "present", dead: "absent" },
      }),
    );
    expect(joined.live.map((r) => r.sessionId)).toEqual(["live"]);
    expect(joined.ghosts.map((r) => r.sessionId)).toEqual(["dead"]);
    expect(joined.ghosts[0]?.pidAlive).toBe(false);
    expect(joined.ghosts[0]?.transcriptState).toBe("absent");
  });

  test("a tree surface with no binding is unbound, not live", () => {
    const joined = joinLiveness(
      tree([loc({ surfaceId: "ORPHAN", workspaceId: "W", workspaceRef: "workspace:9" })]),
      bindings({ sessions: [] }),
    );
    expect(joined.live).toEqual([]);
    expect(joined.unboundSurfaces.map((s) => s.surfaceId)).toEqual(["ORPHAN"]);
  });

  test("unreadable inputs fail closed and keep the max revision", () => {
    const closed = joinLiveness(
      { ...tree([]), readable: false, revision: 4 },
      bindings({ sessions: [entry({ sessionId: "x", surfaceId: "S" })], revision: 7 }),
    );
    expect(closed.readable).toBe(false);
    expect(closed.live).toEqual([]);
    expect(closed.ghosts).toEqual([]);
    expect(closed.revision).toBe(7);
  });

  test("revision is the max of its inputs, never invented", () => {
    const joined: LivenessRead = joinLiveness(
      tree([loc({ surfaceId: "S", workspaceId: "W" })], 2),
      bindings({ sessions: [entry({ sessionId: "a", surfaceId: "S" })], revision: 9 }),
    );
    expect(joined.revision).toBe(9);
  });
});
