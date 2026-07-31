import { expect, test } from "bun:test";
import type { Bridge, SurfaceSession } from "../cmux/bridge.ts";
import type { Launcher } from "./launchers.ts";
import { DEFAULT_SWAP_MODEL, planSwap } from "./swap-harness.ts";
import {
  buildRespawnCommand,
  runRespawn,
  type RespawnEnv,
  type RespawnIo,
} from "./respawn.ts";

const native: Launcher = {
  name: "claude-native",
  binary: "claude-native",
  serves: ["claude-*", "anthropic.*"],
  env: {},
  clears: [],
};
const gpt: Launcher = { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] };
const FLEET = [native, gpt];

const SURFACE = "surface-uuid-1";
const SESSION = "e995627d-0db4-421d-8a7d-982250ef216f";
/** The session's LAUNCH dir, as the caller resolves it from the transcript's storage folder. */
const CWD = "/Users/mimen";

function surfaceSession(over: Partial<SurfaceSession> = {}): SurfaceSession {
  return {
    sessionId: SESSION,
    workspaceId: "ws-1",
    // Deliberately NOT the launch dir: cmux records where the session currently is, and every
    // test here asserts that the plan ignores this in favour of the caller-resolved cwd.
    cwd: "/Users/mimen/Programming/Repos/claude-sessions/.claude/worktrees/swap-harness",
    transcriptPath: "/store/session.jsonl",
    agentLifecycle: "running",
    isRestorable: true,
    pid: 4242,
    lastPermissionMode: "bypassPermissions",
    ...over,
  };
}

/** Bridge stub whose only interesting behaviour is the surface → session binding. */
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

const gptHistory = { models: ["gpt-5.6-sol"], lastModel: "gpt-5.6-sol" };
const claudeHistory = { models: ["claude-opus-5"], lastModel: "claude-opus-5" };
const noHistory = { models: [] as readonly string[], lastModel: "" };

type PlanArgs = Parameters<typeof planSwap>;
/** planSwap with the resolved launch cwd supplied, which every real caller does. */
const plan = (
  e: PlanArgs[0],
  bridge: PlanArgs[1],
  launchers: PlanArgs[2],
  history: PlanArgs[3],
  opts: PlanArgs[4] = {},
) => planSwap(e, bridge, launchers, history, { resumeCwd: CWD, ...opts });

test("a gpt session swaps to claude-native on opus", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.from?.name).toBe("claude-gpt");
  expect(res.value.to.name).toBe("claude-native");
  expect(res.value.model).toBe("opus");
});

test("a claude session swaps to claude-gpt with the canonical default compiled to [1m]", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.from?.name).toBe("claude-native");
  expect(res.value.to.name).toBe("claude-gpt");
  expect(DEFAULT_SWAP_MODEL["claude-gpt"]).toBe("gpt-5.6-sol");
  expect(res.value.model).toBe("gpt-5.6-sol[1m]");
  expect(res.value.command).toContain("--model 'gpt-5.6-sol[1m]'");
});

test("a session already swapped once can swap back (mixed history routes on its last model)", () => {
  const mixed = { models: ["claude-opus-5", "gpt-5.6-sol"], lastModel: "gpt-5.6-sol" };
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, mixed);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.from?.name).toBe("claude-gpt");
  expect(res.value.to.name).toBe("claude-native");
});

test("a session with no assistant turns yet admits it cannot infer the origin", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, noHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("origin-unknown");
});

test("...but an explicit --to swaps it anyway, with the origin left unclaimed", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, noHistory, { to: "claude-gpt" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.from).toBeNull();
  expect(res.value.to.name).toBe("claude-gpt");
  expect(res.value.model).toBe("gpt-5.6-sol[1m]");
});

// --- the cwd trap ---------------------------------------------------------------

test("resumes in the LAUNCH dir, IGNORING cmux's drifted cwd", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (!res.ok) throw new Error("unreachable");
  // cmux says the session is in a worktree; its transcript is filed under the launch dir. Using
  // cmux's value would produce "No conversation found with session ID" on respawn.
  expect(res.value.cwd).toBe(CWD);
  expect(res.value.command).toBe(
    `cd -- ${CWD} && claude-native --resume ${SESSION} --model opus --permission-mode bypassPermissions`,
  );
});

test("refuses when the launch directory could not be resolved from the transcript", () => {
  const res = planSwap(env(), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("cwd-unknown");
});

// --- command shape --------------------------------------------------------------

test("no recorded permission mode → the flag is omitted, not guessed", () => {
  const res = plan(env(), stubBridge(surfaceSession({ lastPermissionMode: null })), FLEET, gptHistory);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.command).not.toContain("--permission-mode");
  expect(res.value.permissionMode).toBeNull();
});

test("--model accepts a canonical override and compiles its launcher spelling", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory, {
    model: "gpt-5.6-terra",
  });
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.model).toBe("gpt-5.6-terra[1m]");
  expect(res.value.command).toContain(`--model 'gpt-5.6-terra[1m]'`);
});

test("--model rejects launcher spellings instead of bypassing the canonical compiler", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, claudeHistory, {
    model: "gpt-5.6-terra[1m]",
  });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("model-unknown");
  expect(res.error.message).toContain("canonical models");
});

test("launcher env vars are exported ahead of the binary", () => {
  expect(
    buildRespawnCommand({
      cwd: "/tmp/x y",
      binary: "claude-gpt",
      sessionId: "s1",
      model: "m1",
      permissionMode: null,
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
    }),
  ).toBe(`cd -- '/tmp/x y' && env ANTHROPIC_BASE_URL=http://127.0.0.1:8317 claude-gpt --resume s1 --model m1`);
});

// --- identity proofs ------------------------------------------------------------

test("refuses when the surface is bound to a DIFFERENT session", () => {
  const res = plan(env(), stubBridge(surfaceSession({ sessionId: "someone-else" })), FLEET, gptHistory);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("identity-mismatch");
});

test("refuses when cmux liveness is unreadable rather than respawning blind", () => {
  const res = plan(env(), stubBridge(surfaceSession(), false), FLEET, gptHistory);
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("liveness-unreadable");
});

test("refuses when nothing is bound to the surface", () => {
  const res = plan(env(), stubBridge(null), FLEET, gptHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("surface-unbound");
});

test("refuses when the env workspace disagrees with cmux's", () => {
  const res = plan(env({ workspaceId: "ws-OTHER" }), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("workspace-mismatch");
});

test("refuses outside a session or outside a cmux surface", () => {
  const noSession = plan(env({ sessionId: null }), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (noSession.ok) throw new Error("unreachable");
  expect(noSession.error.code).toBe("not-in-session");

  const noSurface = plan(env({ surfaceId: null }), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (noSurface.ok) throw new Error("unreachable");
  expect(noSurface.error.code).toBe("not-in-surface");
});

// --- target selection -----------------------------------------------------------

test("refuses to swap a session onto the harness it is already on", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory, { to: "claude-gpt" });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("same-harness");
});

test("an unknown --to lists what is configured", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory, { to: "nope" });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("unknown-launcher");
  expect(res.error.message).toContain("claude-native");
});

test("three launchers make 'the other one' ambiguous — say so instead of picking", () => {
  const third: Launcher = { name: "claude", binary: "claude", serves: ["*"], env: {}, clears: [] };
  const res = plan(env(), stubBridge(surfaceSession()), [...FLEET, third], gptHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("ambiguous-target");
});

test("a target with no default model demands --model rather than inventing one", () => {
  const odd: Launcher = { name: "other", binary: "other", serves: ["x-*"], env: {}, clears: [] };
  const res = plan(env(), stubBridge(surfaceSession()), [native, odd], claudeHistory, { to: "other" });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("model-unknown");
});

// --- the consolidated fleet: swapping CAPABILITY ENVELOPE, not vendor -------------

const claudex: Launcher = { name: "claudex", binary: "claudex", serves: ["*"], env: {}, clears: [] };
const CONSOLIDATED = [claudex, native, gpt];

test("claudex has a default model, so a swap onto it never demands --model", () => {
  expect(DEFAULT_SWAP_MODEL["claudex"]).toBe("opus");
});

test("a Claude session swaps onto claudex, keeping the native `opus` alias", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, claudeHistory, { to: "claudex" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claudex");
  expect(res.value.model).toBe("opus");
  expect(res.value.command).toBe(
    `cd -- ${CWD} && claudex --resume ${SESSION} --model opus --permission-mode bypassPermissions`,
  );
});

// The whole point of the command now: get claude.ai connectors and Remote Control back. The model
// history says "claude-opus-5", which claudex AND claude-native both serve, so the inferred origin
// is claude-native — a guess. Refusing on it would block the only swap that still matters.
test("claudex → claude-native is allowed even though the inferred origin IS claude-native", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, claudeHistory, {
    to: "claude-native",
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claude-native");
  expect(res.value.model).toBe("opus");
});

test("...but a fleet where exactly one launcher can have produced the history still refuses", () => {
  // Two disjoint launchers: only claude-gpt replays gpt-5.6-sol, so the origin is observed, not
  // guessed, and the no-op guard keeps its teeth.
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory, { to: "claude-gpt" });
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("same-harness");
});

test("a GPT session on claudex can be moved to claude-native with a Claude model", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, gptHistory, {
    to: "claude-native",
    model: "claude-opus-5",
  });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.value.to.name).toBe("claude-native");
  expect(res.value.model).toBe("claude-opus-5");
});

test("a bare swap in a three-launcher fleet names the options instead of picking one", () => {
  const res = plan(env(), stubBridge(surfaceSession()), CONSOLIDATED, claudeHistory);
  if (res.ok) throw new Error("unreachable");
  expect(res.error.code).toBe("ambiguous-target");
  expect(res.error.message).toContain("claudex, claude-native, claude-gpt");
});

// --- execution ------------------------------------------------------------------

test("runRespawn hands the planned command to the planned surface", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (!res.ok) throw new Error("unreachable");
  const calls: Array<{ surfaceId: string; command: string }> = [];
  const io: RespawnIo = {
    respawn: (surfaceId, command) => {
      calls.push({ surfaceId, command });
      return { ok: true };
    },
  };
  expect(runRespawn(res.value, io).ok).toBe(true);
  expect(calls).toEqual([{ surfaceId: SURFACE, command: res.value.command }]);
});

test("a failed respawn surfaces the error instead of reporting success", () => {
  const res = plan(env(), stubBridge(surfaceSession()), FLEET, gptHistory);
  if (!res.ok) throw new Error("unreachable");
  const io: RespawnIo = { respawn: () => ({ ok: false, error: "cmux socket refused" }) };
  const out = runRespawn(res.value, io);
  expect(out.ok).toBe(false);
  if (out.ok) throw new Error("unreachable");
  expect(out.error.message).toContain("cmux socket refused");
});
