import { expect, test } from "bun:test";
import type { Bridge, SurfaceSession } from "../cmux/bridge.ts";
import type { Launcher } from "./launchers.ts";
import { planRestart } from "./restart.ts";
import type { RespawnEnv } from "./respawn.ts";

const native: Launcher = {
  name: "claude-native",
  binary: "claude-native",
  serves: ["claude-*", "anthropic.*"],
  env: {},
};
const gpt: Launcher = { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {} };
const FLEET = [native, gpt];

const SURFACE = "surface-uuid-1";
const SESSION = "846f1c6a-2998-4d82-b285-8cda722f77c1";
const CWD = "/Users/mimen/Programming/Repos/claude-sessions";

function surfaceSession(over: Partial<SurfaceSession> = {}): SurfaceSession {
  return {
    sessionId: SESSION,
    workspaceId: "ws-1",
    cwd: "/somewhere/the/agent/wandered",
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

test("--model pins one when you explicitly want that", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory, { model: "sonnet" });
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.model).toBe("sonnet");
  expect(res.value.command).toContain("--model sonnet");
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
