import { describe, expect, test } from "bun:test";
import { CPU_TIE_EPSILON, parseCpuTime, planReap } from "./reap";
import type { SurfaceLocation } from "./bridge";

function loc(surfaceId: string, workspaceRef: string, workspaceTitle: string): SurfaceLocation {
  return {
    surfaceId,
    surfaceRef: `surface:${surfaceId}`,
    surfaceType: "terminal",
    title: null,
    paneId: `pane-${surfaceId}`,
    paneIndex: 0,
    indexInPane: 0,
    workspaceId: `ws-${surfaceId}`,
    workspaceRef,
    workspaceTitle,
    windowId: "win-1",
    windowRef: "window:1",
  };
}

describe("parseCpuTime", () => {
  test("mm:ss.ss", () => expect(parseCpuTime("0:11.62")).toBeCloseTo(11.62));
  test("m:ss (no fraction)", () => expect(parseCpuTime("1:11")).toBe(71));
  test("h:mm:ss.ss", () => expect(parseCpuTime("2:03:04.5")).toBeCloseTo(2 * 3600 + 3 * 60 + 4.5));
  test("d-hh:mm:ss for very long-running procs", () =>
    expect(parseCpuTime("1-02:03:04")).toBe(86400 + 2 * 3600 + 3 * 60 + 4));
});

describe("planReap", () => {
  test("sessions with only one live proc are not reaped", () => {
    const procs = [{ pid: "1", tty: "ttys001", sessionId: "sid-solo", cpuSeconds: 100 }];
    const tty = new Map([["ttys001", loc("s1", "workspace:1", "solo")]]);
    expect(planReap(procs, tty)).toEqual([]);
  });

  test("keeps the twin with the highest CPU-time (the one that actually did work)", () => {
    const s_talked = loc("SURFACE-NEW", "workspace:2", "talked-to twin");
    const s_idle = loc("SURFACE-OLD", "workspace:1", "idle twin");
    const procs = [
      { pid: "10", tty: "ttys011", sessionId: "sid-A", cpuSeconds: 11.6 }, // idle
      { pid: "11", tty: "ttys012", sessionId: "sid-A", cpuSeconds: 71.3 }, // talked-to
    ];
    const tty = new Map([
      ["ttys011", s_idle],
      ["ttys012", s_talked],
    ]);
    const groups = planReap(procs, tty);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keep!.workspace.workspaceRef).toBe("workspace:2");
    expect(groups[0]!.keep!.cpuSeconds).toBeCloseTo(71.3);
    expect(groups[0]!.drop).toHaveLength(1);
    expect(groups[0]!.drop[0]!.workspace.workspaceRef).toBe("workspace:1");
  });

  test("cpu-tie: closes ALL twins, no keep (both procs indistinguishable)", () => {
    const procs = [
      { pid: "1", tty: "ttys011", sessionId: "sid-tie", cpuSeconds: 3.1 },
      { pid: "2", tty: "ttys012", sessionId: "sid-tie", cpuSeconds: 4.0 }, // < 5s epsilon
    ];
    const tty = new Map([
      ["ttys011", loc("s11", "workspace:11", "tie a")],
      ["ttys012", loc("s12", "workspace:12", "tie b")],
    ]);
    const groups = planReap(procs, tty);
    expect(groups[0]!.keep).toBeNull();
    expect(groups[0]!.keepReason).toBe("cpu-tie");
    expect(groups[0]!.drop.map((d) => d.workspace.workspaceRef).sort()).toEqual([
      "workspace:11",
      "workspace:12",
    ]);
  });

  test("clear winner beats the epsilon (real 3f5ca3ef case: 11.6s vs 71.3s)", () => {
    expect(71.3 - 11.6).toBeGreaterThan(CPU_TIE_EPSILON);
  });

  test("procs with no matching cmux surface are orphans (left alone)", () => {
    const procs = [
      { pid: "10", tty: "ttys060", sessionId: "sid-C", cpuSeconds: 100 }, // in cmux
      { pid: "11", tty: "ttys999", sessionId: "sid-C", cpuSeconds: 50 }, // NOT in cmux
    ];
    const tty = new Map([["ttys060", loc("s60", "workspace:60", "in cmux")]]);
    const groups = planReap(procs, tty);
    expect(groups[0]!.orphans).toHaveLength(1);
    expect(groups[0]!.drop).toHaveLength(0); // only one in-cmux surface → no drop
  });

  test("triplicate with one clear winner: keeps the leader, drops both losers", () => {
    const procs = [
      { pid: "1", tty: "ttys011", sessionId: "sid-D", cpuSeconds: 2 },
      { pid: "2", tty: "ttys012", sessionId: "sid-D", cpuSeconds: 60 }, // winner
      { pid: "3", tty: "ttys013", sessionId: "sid-D", cpuSeconds: 1 },
    ];
    const tty = new Map([
      ["ttys011", loc("s11", "workspace:11", "a")],
      ["ttys012", loc("s12", "workspace:12", "b")],
      ["ttys013", loc("s13", "workspace:13", "c")],
    ]);
    const groups = planReap(procs, tty);
    expect(groups[0]!.keep!.workspace.workspaceRef).toBe("workspace:12");
    expect(groups[0]!.drop.map((d) => d.workspace.workspaceRef).sort()).toEqual([
      "workspace:11",
      "workspace:13",
    ]);
  });
});
