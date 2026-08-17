import { expect, test } from "bun:test";
import type { Bridge, SurfaceSession } from "../cmux/bridge.ts";
import type { Launcher } from "./launchers.ts";
import { describeRestart, planRestart } from "./restart.ts";
import type { RespawnEnv } from "./respawn.ts";

const native: Launcher = {
  name: "claude-native",
  binary: "claude-native",
  serves: ["claude-*", "anthropic.*"],
  env: {},
  clears: [],
};
const gpt: Launcher = {
  name: "claude-gpt",
  binary: "claude-gpt",
  serves: ["gpt-5.6-*"],
  env: {},
  clears: [],
};
const claudex: Launcher = {
  name: "claudex",
  binary: "claudex",
  serves: ["claude-*", "gpt-5.6-*"],
  env: {},
  clears: [],
};
const FLEET = [native, gpt];

const SURFACE = "surface-uuid-1";
const SESSION = "846f1c6a-2998-4d82-b285-8cda722f77c1";
const CWD = "/Users/mimen/Programming/Repos/claude-sessions";

function surfaceSession(over: Partial<SurfaceSession> = {}): SurfaceSession {
  return {
    sessionId: SESSION,
    workspaceId: "ws-1",
    cwd: "/somewhere/the/agent/wandered",
    transcriptPath: "/store/session.jsonl",
    agentLifecycle: "running",
    isRestorable: true,
    pid: 4242,
    lastPermissionMode: "bypassPermissions",
    ...over,
  };
}

function stubBridge(bound: SurfaceSession | null, readable = true): Bridge {
  return {
    surfaces: [],
    activeWindowId: null,
    surfaceToWorkspace: new Map(),
    workspaceIds: () => [],
    surfacesInWorkspace: () => [],
    surfaceInfo: (id: string) => (id === SURFACE ? bound : null),
    locateSession: () => null,
    isOpen: () => false,
    primarySurface: () => null,
    readable,
  };
}

const env = (over: Partial<RespawnEnv> = {}): RespawnEnv => ({
  sessionId: SESSION,
  surfaceId: SURFACE,
  workspaceId: "ws-1",
  ...over,
});

const claudeHistory = { models: ["claude-opus-4-8"], lastModel: "claude-opus-4-8" };
const gptHistory = { models: ["gpt-5.6-sol"], lastModel: "gpt-5.6-sol" };
const noHistory = { models: [] as readonly string[], lastModel: "" };

type Args = Parameters<typeof planRestart>;
const plan = (
  e: Args[0],
  bridge: Args[1],
  launchers: Args[2],
  history: Args[3],
  opts: Args[4] = {},
) => planRestart(e, bridge, launchers, history, { resumeCwd: CWD, ...opts });

test("restart comes back on the SAME harness", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.from?.name).toBe("claude-native");
  expect(res.value.to.name).toBe("claude-native");
});

test("a gpt session restarts on claude-gpt, not the native launcher", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claude-gpt");
});

test("NO --model is passed, so a settings alias re-resolves to whatever shipped since", () => {
  // The whole point: a session started before a new model existed resolves `opus` at STARTUP and
  // is stuck with the old one. Pinning the recorded model id here would make restart pointless.
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.model).toBeNull();
  expect(res.value.command).not.toContain("--model");
  expect(res.value.command).toBe(
    `cd -- ${CWD} && claude-native --resume ${SESSION} --permission-mode bypassPermissions`,
  );
});

test("--model pins a canonical model with its compiled launcher spelling", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory, {
    model: "gpt-5.6-terra",
  });
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.model).toBe("gpt-5.6-terra");
  expect(res.value.command).toContain("--model gpt-5.6-terra");
});

test("--model rejects aliases before constructing a restart command", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory, { model: "sonnet" });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("model-unknown");
});

test("restart uses the LAUNCH dir, not cmux's drifted cwd", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.cwd).toBe(CWD);
});

test("an unindexed session with a single-launcher fleet still restarts", () => {
  const res = plan(env(), stubBridge(surfaceSession()), [native], noHistory);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.from).toBeNull();
  expect(res.value.to.name).toBe("claude-native");
});

test("an unindexed session with two launchers asks which one rather than guessing", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, noHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("origin-unknown");
  expect(res.error.message).toContain("--on");
});

test("--on overrides the harness for the odd case", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory, { on: "claude-gpt" });
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claude-gpt");
});

test("an unknown --on lists what is configured", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory, { on: "nope" });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("unknown-launcher");
});

test("restart shares the identity proofs — a mismatched surface is refused", () => {
  const res = plan(
    env(),
    stubBridge(surfaceSession({ sessionId: "someone-else" })),
    FLEET,
    claudeHistory,
  );
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("identity-mismatch");
});

test("restart fails closed when cmux liveness is unreadable", () => {
  const res = plan(env(), stubBridge(surfaceSession(), false), FLEET, claudeHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("liveness-unreadable");
});

test("restart refuses without a transcript-resolved launch dir", () => {
  const res = planRestart(env(), stubBridge(surfaceSession()), FLEET, claudeHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("cwd-unknown");
});

// --- the consolidated fleet: a bare restart must not silently change envelope -----

const CONSOLIDATED = [claudex, native, gpt];

test("a bare Claude restart refuses when claudex and claude-native can both replay the history", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, claudeHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("origin-unknown");
  expect(res.error.message).toContain("pass --on");
});

test("a bare GPT restart refuses when claudex and claude-gpt can both replay the history", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, gptHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("origin-unknown");
  expect(res.error.message).toContain("pass --on");
});

test("a disjoint two-launcher fleet still OBSERVES the origin and says nothing extra", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.originCertain).toBe(true);
  expect(describeRestart(res.value)).not.toContain("INFERRED");
});

test("--on claudex pins the shared launcher while keeping the settings alias unpinned", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, claudeHistory, { on: "claudex" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claudex");
  expect(res.value.model).toBeNull();
  expect(res.value.command).not.toContain("--model");
});

test("--on claude-native pins the native launcher despite the overlapping Claude history", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, claudeHistory, {
    on: "claude-native",
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claude-native");
  expect(res.value.command).toContain("claude-native --resume");
});

test("--on claude-gpt pins the GPT-5.6 launcher despite the overlapping GPT history", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, gptHistory, {
    on: "claude-gpt",
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claude-gpt");
  expect(res.value.command).toContain("claude-gpt --resume");
});
