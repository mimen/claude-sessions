import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bridge, SurfaceLocation, SurfaceSession } from "./bridge.ts";
import {
  closeCurrentWorkspaceCommand,
  closeSessionWorkspace,
  closeSessionWorkspaceCandidates,
  closeWorkspaceByStableId,
  currentWorkspaceIdentity,
  planCloseCurrentWorkspace,
  planCloseSessionWorkspace,
  planCloseSessionWorkspaceCandidates,
  type CloseAttempt,
  type CloseCurrentWorkspaceDependencies,
  type CloseProcessRunner,
  type CloseRefusalReason,
  type CloseSessionWorkspaceDependencies,
  type CurrentWorkspaceEnvironment,
} from "./close-current.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SURFACE_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const OTHER_SURFACE_ID = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
const WORKSPACE_ID = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";
const OTHER_WORKSPACE_ID = "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD";

const environment: CurrentWorkspaceEnvironment = {
  CLAUDE_CODE_SESSION_ID: SESSION_ID,
  CMUX_SURFACE_ID: SURFACE_ID,
  CMUX_WORKSPACE_ID: WORKSPACE_ID,
};

function surface(overrides: Partial<SurfaceLocation> = {}): SurfaceLocation {
  return {
    surfaceId: SURFACE_ID,
    surfaceRef: "surface:1",
    surfaceType: "terminal",
    title: null,
    paneId: "pane-id",
    paneIndex: 0,
    indexInPane: 0,
    workspaceId: WORKSPACE_ID,
    workspaceRef: "workspace:1",
    workspaceTitle: "Current",
    windowId: "window-id",
    windowRef: "window:1",
    ...overrides,
  };
}

function binding(overrides: Partial<SurfaceSession> = {}): SurfaceSession {
  return {
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    cwd: null,
    agentLifecycle: "running",
    isRestorable: true,
    pid: 123,
    ...overrides,
  };
}

function bridge(overrides: Partial<Bridge> = {}): Bridge {
  const current = surface();
  const currentBinding = binding();
  return {
    surfaces: [current],
    surfaceToWorkspace: new Map([[SURFACE_ID, current]]),
    workspaceIds: () => [WORKSPACE_ID],
    surfacesInWorkspace: (workspaceId) => workspaceId === WORKSPACE_ID ? [current] : [],
    surfaceInfo: (surfaceId) => surfaceId === SURFACE_ID ? currentBinding : null,
    activeWindowId: null,
    readable: true,
    locateSession: (sessionId) => sessionId === SESSION_ID ? current : null,
    isOpen: (sessionId) => sessionId === SESSION_ID,
    primarySurface: (workspaceId) => workspaceId === WORKSPACE_ID ? current : null,
    ...overrides,
  };
}

function expectRefusal(actual: ReturnType<typeof planCloseCurrentWorkspace>, reason: CloseRefusalReason): void {
  expect(actual).toEqual({ status: "refused", reason });
}

describe("currentWorkspaceIdentity", () => {
  test("requires three valid stable UUIDs", () => {
    expect(currentWorkspaceIdentity(environment)).toEqual({
      status: "authorized",
      identity: {
        sessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("refuses every missing or malformed identity input", () => {
    const cases: Array<[CurrentWorkspaceEnvironment, CloseRefusalReason]> = [
      [{}, "missing-session-id"],
      [{ CLAUDE_CODE_SESSION_ID: "not-a-uuid" }, "invalid-session-id"],
      [{ CLAUDE_CODE_SESSION_ID: SESSION_ID }, "missing-surface-id"],
      [{ CLAUDE_CODE_SESSION_ID: SESSION_ID, CMUX_SURFACE_ID: "bad" }, "invalid-surface-id"],
      [{ CLAUDE_CODE_SESSION_ID: SESSION_ID, CMUX_SURFACE_ID: SURFACE_ID }, "missing-workspace-id"],
      [{ ...environment, CMUX_WORKSPACE_ID: "workspace:1" }, "invalid-workspace-id"],
    ];

    for (const [input, reason] of cases) {
      expect(currentWorkspaceIdentity(input)).toEqual({ status: "refused", reason });
    }
  });
});

describe("planCloseCurrentWorkspace", () => {
  test("authorizes an exact, sole, primary binding", () => {
    expect(planCloseCurrentWorkspace(bridge(), environment)).toEqual({
      status: "authorized",
      identity: {
        sessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("refuses unreadable live state", () => {
    expectRefusal(planCloseCurrentWorkspace(bridge({ readable: false }), environment), "bridge-unreadable");
  });

  test("refuses a surface absent from the live tree", () => {
    expectRefusal(
      planCloseCurrentWorkspace(bridge({ surfaceToWorkspace: new Map() }), environment),
      "surface-not-live",
    );
  });

  test("refuses disagreement between env and tree workspace UUIDs", () => {
    const wrong = surface({ workspaceId: OTHER_WORKSPACE_ID });
    expectRefusal(
      planCloseCurrentWorkspace(
        bridge({ surfaceToWorkspace: new Map([[SURFACE_ID, wrong]]) }),
        environment,
      ),
      "tree-workspace-mismatch",
    );
  });

  test("refuses an unbound current surface", () => {
    expectRefusal(planCloseCurrentWorkspace(bridge({ surfaceInfo: () => null }), environment), "surface-not-bound");
  });

  test("refuses a current surface bound to another session", () => {
    expectRefusal(
      planCloseCurrentWorkspace(
        bridge({ surfaceInfo: () => binding({ sessionId: OTHER_SESSION_ID }) }),
        environment,
      ),
      "surface-session-mismatch",
    );
  });

  test("refuses missing hook-store workspace identity", () => {
    expectRefusal(
      planCloseCurrentWorkspace(bridge({ surfaceInfo: () => binding({ workspaceId: null }) }), environment),
      "hook-workspace-missing",
    );
  });

  test("refuses disagreement between env and hook-store workspace UUIDs", () => {
    expectRefusal(
      planCloseCurrentWorkspace(
        bridge({ surfaceInfo: () => binding({ workspaceId: OTHER_WORKSPACE_ID }) }),
        environment,
      ),
      "hook-workspace-mismatch",
    );
  });

  test("refuses when the session is not live", () => {
    expectRefusal(planCloseCurrentWorkspace(bridge({ locateSession: () => null }), environment), "session-not-live");
  });

  test("refuses reattach drift to another surface", () => {
    const moved = surface({ surfaceId: OTHER_SURFACE_ID });
    expectRefusal(
      planCloseCurrentWorkspace(bridge({ locateSession: () => moved }), environment),
      "session-surface-mismatch",
    );
  });

  test("refuses disagreement in the located session workspace", () => {
    const moved = surface({ workspaceId: OTHER_WORKSPACE_ID });
    expectRefusal(
      planCloseCurrentWorkspace(bridge({ locateSession: () => moved }), environment),
      "session-workspace-mismatch",
    );
  });

  test("refuses a non-primary session", () => {
    const other = surface({ surfaceId: OTHER_SURFACE_ID });
    expectRefusal(
      planCloseCurrentWorkspace(bridge({ primarySurface: () => other }), environment),
      "not-primary-surface",
    );
  });

  test("refuses a workspace shared with another Claude-bound surface", () => {
    const current = surface();
    const other = surface({
      surfaceId: OTHER_SURFACE_ID,
      surfaceRef: "surface:2",
      indexInPane: 1,
    });
    expectRefusal(
      planCloseCurrentWorkspace(
        bridge({
          surfaces: [current, other],
          surfacesInWorkspace: () => [current, other],
          surfaceInfo: (surfaceId) => surfaceId === SURFACE_ID
            ? binding()
            : binding({ sessionId: OTHER_SESSION_ID }),
        }),
        environment,
      ),
      "shared-workspace",
    );
  });

  test("refuses any extra live surface even when cmux has no Claude binding for it", () => {
    const current = surface();
    const other = surface({
      surfaceId: OTHER_SURFACE_ID,
      surfaceRef: "surface:2",
      surfaceType: "browser",
      indexInPane: 1,
    });
    expectRefusal(
      planCloseCurrentWorkspace(
        bridge({
          surfaces: [current, other],
          surfacesInWorkspace: () => [current, other],
          surfaceInfo: (surfaceId) => surfaceId === SURFACE_ID ? binding() : null,
        }),
        environment,
      ),
      "shared-workspace",
    );
  });
});

describe("explicit-session close planning", () => {
  test("resolves the session through the bridge without current-workspace environment", () => {
    expect(planCloseSessionWorkspace(bridge(), SESSION_ID)).toEqual({
      status: "authorized",
      identity: {
        sessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("accepts canonical/resume candidates only when exactly one live body resolves", () => {
    expect(planCloseSessionWorkspaceCandidates(
      bridge(),
      [OTHER_SESSION_ID, SESSION_ID],
    )).toEqual({
      status: "authorized",
      identity: {
        sessionId: SESSION_ID,
        surfaceId: SURFACE_ID,
        workspaceId: WORKSPACE_ID,
      },
    });
  });

  test("refuses invalid ids and absent sessions rather than guessing", () => {
    expect(planCloseSessionWorkspace(bridge(), "not-a-uuid")).toEqual({
      status: "refused",
      reason: "invalid-session-id",
    });
    expect(planCloseSessionWorkspace(bridge(), OTHER_SESSION_ID)).toEqual({
      status: "refused",
      reason: "session-not-live",
    });
  });
});

function explicitCloseDeps(
  bridges: Bridge[],
  closeResult: CloseAttempt = { ok: true },
): {
  readonly deps: CloseSessionWorkspaceDependencies;
  readonly closed: Array<{ readonly workspaceId: string; readonly workspaceRef: string }>;
  bridgeCalls(): number;
} {
  let bridgeIndex = 0;
  const closed: Array<{ readonly workspaceId: string; readonly workspaceRef: string }> = [];
  return {
    deps: {
      bridge: () => {
        const selected = bridges[Math.min(bridgeIndex, bridges.length - 1)];
        bridgeIndex += 1;
        if (!selected) throw new Error("test requires at least one bridge");
        return selected;
      },
      close: (workspaceId, location) => {
        closed.push({ workspaceId, workspaceRef: location.workspaceRef });
        return closeResult;
      },
    },
    closed,
    bridgeCalls: () => bridgeIndex,
  };
}

describe("closeSessionWorkspace", () => {
  test("dry-run performs one bridge proof and never invokes close", async () => {
    const state = explicitCloseDeps([bridge()]);

    await expect(closeSessionWorkspace(SESSION_ID, false, state.deps)).resolves.toEqual({
      status: "authorized",
      dryRun: true,
      identity: { sessionId: SESSION_ID, surfaceId: SURFACE_ID, workspaceId: WORKSPACE_ID },
    });
    expect(state.bridgeCalls()).toBe(1);
    expect(state.closed).toEqual([]);
  });

  test("mutation revalidates the first stable identity and closes by workspace UUID", async () => {
    const state = explicitCloseDeps([bridge(), bridge()]);

    await expect(closeSessionWorkspaceCandidates(
      [OTHER_SESSION_ID, SESSION_ID],
      true,
      state.deps,
    )).resolves.toEqual({
      status: "closed",
      identity: { sessionId: SESSION_ID, surfaceId: SURFACE_ID, workspaceId: WORKSPACE_ID },
    });
    expect(state.bridgeCalls()).toBe(2);
    expect(state.closed).toEqual([{ workspaceId: WORKSPACE_ID, workspaceRef: "workspace:1" }]);
  });

  test("reattach drift between proofs refuses without invoking close", async () => {
    const moved = surface({ surfaceId: OTHER_SURFACE_ID, workspaceId: OTHER_WORKSPACE_ID });
    const state = explicitCloseDeps([
      bridge(),
      bridge({ locateSession: () => moved }),
    ]);

    await expect(closeSessionWorkspace(SESSION_ID, true, state.deps)).resolves.toEqual({
      status: "refused",
      phase: "revalidation",
      reason: "session-surface-mismatch",
    });
    expect(state.closed).toEqual([]);
  });

  test("close failure is returned once without retry", async () => {
    const state = explicitCloseDeps([bridge(), bridge()], { ok: false });

    await expect(closeSessionWorkspace(SESSION_ID, true, state.deps)).resolves.toMatchObject({
      status: "close-failed",
      identity: { workspaceId: WORKSPACE_ID },
    });
    expect(state.closed).toHaveLength(1);
  });
});

describe("closeWorkspaceByStableId", () => {
  test("uses the stable workspace UUID and never a numeric ref", () => {
    const calls: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
    const runner: CloseProcessRunner = {
      run(file, args, timeoutMs): CloseAttempt {
        calls.push({ file, args, timeoutMs });
        return { ok: true };
      },
    };

    expect(closeWorkspaceByStableId(runner, "/cmux", WORKSPACE_ID)).toEqual({ ok: true });
    expect(calls).toEqual([{
      file: "/cmux",
      args: ["close-workspace", "--workspace", WORKSPACE_ID],
      timeoutMs: 5_000,
    }]);
  });
});

function commandDeps(
  bridges: Bridge[],
  closeResult: CloseAttempt = { ok: true },
): {
  deps: CloseCurrentWorkspaceDependencies;
  closed: string[];
  stdout: string[];
  stderr: string[];
  bridgeCalls: () => number;
} {
  const closed: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let bridgeIndex = 0;
  return {
    deps: {
      environment,
      bridge: () => {
        const selected = bridges[Math.min(bridgeIndex, bridges.length - 1)];
        bridgeIndex += 1;
        if (!selected) throw new Error("test requires at least one bridge");
        return selected;
      },
      close: (workspaceId) => {
        closed.push(workspaceId);
        return closeResult;
      },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    closed,
    stdout,
    stderr,
    bridgeCalls: () => bridgeIndex,
  };
}

describe("closeCurrentWorkspaceCommand", () => {
  test("dry-run performs one proof and never closes", () => {
    const state = commandDeps([bridge()]);
    expect(closeCurrentWorkspaceCommand([], state.deps)).toBe(0);
    expect(state.bridgeCalls()).toBe(1);
    expect(state.closed).toEqual([]);
    expect(JSON.parse(state.stdout[0] ?? "{}")).toMatchObject({
      status: "authorized",
      dryRun: true,
      workspaceId: WORKSPACE_ID,
    });
  });

  test("--do requires two fresh proofs then closes exactly once", () => {
    const state = commandDeps([bridge(), bridge()]);
    expect(closeCurrentWorkspaceCommand(["--do"], state.deps)).toBe(0);
    expect(state.bridgeCalls()).toBe(2);
    expect(state.closed).toEqual([WORKSPACE_ID]);
  });

  test("missing identity refuses before reading live state", () => {
    const state = commandDeps([bridge()]);
    state.deps.environment = {};
    expect(closeCurrentWorkspaceCommand(["--do"], state.deps)).toBe(2);
    expect(state.bridgeCalls()).toBe(0);
    expect(state.closed).toEqual([]);
  });

  test("a preflight refusal makes zero close calls", () => {
    const state = commandDeps([bridge({ readable: false })]);
    expect(closeCurrentWorkspaceCommand(["--do"], state.deps)).toBe(2);
    expect(state.bridgeCalls()).toBe(1);
    expect(state.closed).toEqual([]);
    expect(JSON.parse(state.stderr[0] ?? "{}")).toMatchObject({
      status: "refused",
      phase: "preflight",
      reason: "bridge-unreadable",
    });
  });

  test("second-snapshot drift makes zero close calls", () => {
    const moved = surface({ surfaceId: OTHER_SURFACE_ID });
    const state = commandDeps([bridge(), bridge({ locateSession: () => moved })]);
    expect(closeCurrentWorkspaceCommand(["--do"], state.deps)).toBe(2);
    expect(state.bridgeCalls()).toBe(2);
    expect(state.closed).toEqual([]);
    expect(JSON.parse(state.stderr[0] ?? "{}")).toMatchObject({
      status: "refused",
      phase: "revalidation",
      reason: "session-surface-mismatch",
    });
  });

  test("close failure returns nonzero without retry", () => {
    const state = commandDeps([bridge(), bridge()], { ok: false });
    expect(closeCurrentWorkspaceCommand(["--do"], state.deps)).toBe(1);
    expect(state.closed).toEqual([WORKSPACE_ID]);
    expect(JSON.parse(state.stderr[0] ?? "{}")).toMatchObject({
      status: "close-failed",
      workspaceId: WORKSPACE_ID,
    });
  });

  test("unknown arguments refuse before reading live state", () => {
    const state = commandDeps([bridge()]);
    expect(closeCurrentWorkspaceCommand(["--workspace", "workspace:1"], state.deps)).toBe(2);
    expect(state.bridgeCalls()).toBe(0);
    expect(state.closed).toEqual([]);
  });
});

describe("production cmux targeting", () => {
  test("uses CMUX_BIN for both bridge proofs and the destructive close", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-close-cmux-bin-"));
    const cmuxBin = join(root, "fake-cmux");
    const callLog = join(root, "calls.log");
    const hookStorePath = join(root, "hook-store.json");
    const repoRoot = join(import.meta.dir, "..", "..");
    const tree = {
      windows: [{
        id: "window-id",
        ref: "window:1",
        workspaces: [{
          id: WORKSPACE_ID,
          ref: "workspace:1",
          title: "Test",
          panes: [{
            id: "pane-id",
            ref: "pane:1",
            index: 0,
            surfaces: [{
              id: SURFACE_ID,
              ref: "surface:1",
              type: "terminal",
              index_in_pane: 0,
            }],
          }],
        }],
      }],
    };
    const store = {
      sessions: {
        [SESSION_ID]: {
          sessionId: SESSION_ID,
          surfaceId: SURFACE_ID,
          workspaceId: WORKSPACE_ID,
          pid: null,
        },
      },
      activeSessionsBySurface: {
        [SURFACE_ID]: { sessionId: SESSION_ID },
      },
    };

    try {
      writeFileSync(cmuxBin, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CMUX_CALL_LOG"\ncase "$1" in\n  --version) printf 'cmux 0.64.18\\n' ;;\n  tree) printf '%s\\n' "$CMUX_TREE_JSON" ;;\n  close-workspace) exit 0 ;;\n  *) exit 1 ;;\nesac\n`);
      chmodSync(cmuxBin, 0o755);
      writeFileSync(hookStorePath, JSON.stringify(store));

      const result = Bun.spawnSync({
        cmd: [join(repoRoot, "bin", "ccs"), "close-current-workspace", "--do"],
        cwd: repoRoot,
        env: {
          ...process.env,
          CCS_ROOT: root,
          CMUX_BIN: cmuxBin,
          CMUX_CALL_LOG: callLog,
          CMUX_TREE_JSON: JSON.stringify(tree),
          CMUX_HOOK_STORE_PATH: hookStorePath,
          CLAUDE_CODE_SESSION_ID: SESSION_ID,
          CMUX_SURFACE_ID: SURFACE_ID,
          CMUX_WORKSPACE_ID: WORKSPACE_ID,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).toContain('"status":"closed"');
      expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
        "--version",
        "tree --all --json --id-format both",
        "--version",
        "tree --all --json --id-format both",
        `close-workspace --workspace ${WORKSPACE_ID}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
