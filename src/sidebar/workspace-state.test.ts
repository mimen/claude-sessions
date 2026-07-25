import { describe, expect, test } from "bun:test";
import {
  createCachedWorkspaceStateReader,
  parseWorkspaceState,
  readWorkspaceStates,
} from "./workspace-state.ts";
import type { WorkspaceState } from "./workspace-state.ts";

const DIRTY_FIXTURE = `
tab=B693729B-9334-4691-B427-0D90828F3D5D
color=#20B8C8
cwd=/Users/mimen/Documents/milad-vault/Workspaces/Events
focused_cwd=/Users/mimen/Documents/milad-vault/Workspaces/Events
focused_panel=C4DDE3EF-49DF-4A31-AA93-EDBCEE8C4EA1
git_branch=feat/ccs-machine-capability dirty
pr=none
pr_label=none
ports=none
progress=none
status_count=1
  claude_code=Needs input icon=bell.fill color=#4C8DFF
meta_block_count=0
log_count=0
`.trim();

const MULTI_PORT_FIXTURE = `
tab=30489798-AE89-42C7-8DA4-B5E6C75FA457
color=none
cwd=/Users/mimen/Programming/Repos/dj-artist-manager
focused_cwd=/Users/mimen/Programming/Repos/dj-artist-manager
focused_panel=7008F442-4073-4999-A68E-D3E72B92673F
git_branch=master dirty
pr=none
pr_label=none
ports=1420,54736,57613,57800,58586,58609,58736,58775,58997,59036,59206,59549
progress=none
status_count=1
  claude_code=Needs input icon=bell.fill color=#4C8DFF
meta_block_count=0
log_count=0
`.trim();

const PULL_REQUEST_FIXTURE = `
tab=96B4CF84-5353-4883-903E-50ED441FE9E4
color=none
cwd=/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/close-workspace
focused_cwd=/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/close-workspace
focused_panel=1A23ED79-3871-4990-A89A-50D83B821B5F
git_branch=worktree-close-workspace clean
pr=#3 merged https://github.com/mimen/claude-sessions/pull/3
pr_label=PR
ports=none
progress=none
status_count=1
  claude_code=Needs input icon=bell.fill color=#4C8DFF
meta_block_count=0
log_count=0
`.trim();

const ABSENT_FIXTURE = `
tab=0EAA79F5-668F-4E6C-A0F9-FBE891C46337
color=none
cwd=/Users/mimen
focused_cwd=/Users/mimen
focused_panel=CA9672EB-504E-41EA-B410-7C16189CA66B
git_branch=none
pr=none
pr_label=none
ports=8787
progress=none
status_count=1
  claude_code=Running icon=bolt.fill color=#4C8DFF
meta_block_count=0
log_count=0
`.trim();

const PROGRESS_FIXTURE = `
tab=workspace-id
color=#7057C7
cwd=/tmp/sidebar-build
focused_cwd=/tmp/sidebar-build
focused_panel=panel-id
git_branch=main clean
pr=#42 open https://github.com/example/sidebar/pull/42
pr_label=Review
ports=3000,8787
progress=0.50 Building sidebar
status_count=0
meta_block_count=0
log_count=0
`.trim();

function parsed(fixture: string): WorkspaceState {
  const state = parseWorkspaceState(fixture);
  if (!state) throw new Error("Expected fixture to parse");
  return state;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("parseWorkspaceState", () => {
  test("reads the captured dirty workspace and absent sentinels", () => {
    expect(parseWorkspaceState(DIRTY_FIXTURE)).toEqual({
      branch: "feat/ccs-machine-capability",
      dirty: true,
      pr: null,
      ports: [],
      progress: null,
      color: "#20B8C8",
      cwd: "/Users/mimen/Documents/milad-vault/Workspaces/Events",
    });
  });

  test("maps cmux's absent sentinels without inventing branch state", () => {
    expect(parseWorkspaceState(ABSENT_FIXTURE)).toEqual({
      branch: null,
      dirty: false,
      pr: null,
      ports: [8787],
      progress: null,
      color: null,
      cwd: "/Users/mimen",
    });
  });

  test("reads cmux's comma-separated multi-port shape", () => {
    expect(parseWorkspaceState(MULTI_PORT_FIXTURE)?.ports).toEqual([
      1420,
      54736,
      57613,
      57800,
      58586,
      58609,
      58736,
      58775,
      58997,
      59036,
      59206,
      59549,
    ]);
  });

  test("structures the captured pull request state", () => {
    expect(parseWorkspaceState(PULL_REQUEST_FIXTURE)).toMatchObject({
      branch: "worktree-close-workspace",
      dirty: false,
      pr: {
        number: 3,
        status: "merged",
        url: "https://github.com/mimen/claude-sessions/pull/3",
        label: "PR",
      },
    });
  });

  test("reads progress values and multi-word labels", () => {
    expect(parseWorkspaceState(PROGRESS_FIXTURE)).toMatchObject({
      ports: [3000, 8787],
      progress: { value: 0.5, label: "Building sidebar" },
    });
  });

  test("returns null for malformed input instead of keeping a partial state", () => {
    expect(parseWorkspaceState(PROGRESS_FIXTURE.replace("ports=3000,8787", "ports=3000;8787")))
      .toBeNull();
    expect(parseWorkspaceState("ERROR: Tab not found")).toBeNull();
  });
});

describe("readWorkspaceStates", () => {
  test("targets stable workspace UUIDs once and keys results by UUID", async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly binary: string }> = [];
    const states = await readWorkspaceStates(
      ["workspace-uuid", "workspace-uuid"],
      "fake-cmux",
      async (args, binary) => {
        calls.push({ args, binary });
        return DIRTY_FIXTURE;
      },
    );

    expect(calls).toEqual([{
      args: ["sidebar-state", "--workspace", "workspace-uuid"],
      binary: "fake-cmux",
    }]);
    expect(states.get("workspace-uuid")).toEqual(parsed(DIRTY_FIXTURE));
  });

  test("degrades unreadable, malformed, and throwing commands to null", async () => {
    const states = await readWorkspaceStates(
      ["unreadable", "malformed", "throws"],
      "fake-cmux",
      async (args) => {
        const workspaceId = args[2];
        if (workspaceId === "unreadable") return null;
        if (workspaceId === "malformed") return "not key-value output";
        throw new Error("socket failed");
      },
    );

    expect(states).toEqual(new Map([
      ["unreadable", null],
      ["malformed", null],
      ["throws", null],
    ]));
  });
});

describe("createCachedWorkspaceStateReader", () => {
  test("serves warm state immediately and single-flights an expired background refresh", async () => {
    let clock = 1_000;
    let calls = 0;
    const first = new Map<string, WorkspaceState | null>([["workspace-uuid", parsed(DIRTY_FIXTURE)]]);
    const second = new Map<string, WorkspaceState | null>([["workspace-uuid", parsed(PULL_REQUEST_FIXTURE)]]);
    const refresh = deferred<Map<string, WorkspaceState | null>>();
    const reader = createCachedWorkspaceStateReader(
      "fake-cmux",
      100,
      () => clock,
      () => {
        calls += 1;
        return calls === 1 ? Promise.resolve(first) : refresh.promise;
      },
    );

    expect(await reader.read(["workspace-uuid"])).toEqual(first);
    expect(await reader.read(["workspace-uuid"])).toEqual(first);
    expect(calls).toBe(1);

    clock += 100;
    expect(await reader.read(["workspace-uuid"])).toEqual(first);
    expect(await reader.read(["workspace-uuid"])).toEqual(first);
    expect(calls).toBe(2);

    refresh.resolve(second);
    await refresh.promise;
    await Promise.resolve();
    expect(await reader.read(["workspace-uuid"])).toEqual(second);
    expect(calls).toBe(2);
  });

  test("turns an unexpected initial sweep failure into null state", async () => {
    const reader = createCachedWorkspaceStateReader(
      "fake-cmux",
      100,
      () => 1_000,
      () => {
        throw new Error("unexpected reader failure");
      },
    );

    await expect(reader.read(["workspace-uuid"])).resolves.toEqual(new Map([
      ["workspace-uuid", null],
    ]));
  });
});
