import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bridge, SurfaceSession } from "../cmux/bridge.ts";
import { openIndex } from "../index/schema.ts";
import { ok } from "../result.ts";
import type { Launcher } from "./launchers.ts";
import { encodePath } from "./locate.ts";
import {
  restartCommand,
  swapHarnessCommand,
  type RespawnCommandDependencies,
} from "./respawn-command.ts";
import type { RespawnEnv, RespawnIo } from "./respawn.ts";

const SESSION = "e995627d-0db4-421d-8a7d-982250ef216f";
const SURFACE = "surface-1";
const WORKSPACE = "workspace-1";
const FLEET: Launcher[] = [
  { name: "claude-native", binary: "claude-native", serves: ["claude-*"], env: {}, clears: [] },
  { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] },
];
const ENVIRONMENT: RespawnEnv = {
  sessionId: SESSION,
  surfaceId: SURFACE,
  workspaceId: WORKSPACE,
};

interface Fixture {
  readonly root: string;
  readonly dbPath: string;
  readonly cwd: string;
  readonly transcriptPath: string;
  readonly bridge: Bridge;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-respawn-command-"));
  const cwd = join(root, "launch-cwd");
  mkdirSync(cwd, { recursive: true });
  const canonicalCwd = realpathSync(cwd);
  const transcriptDir = join(root, encodePath(canonicalCwd));
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${SESSION}.jsonl`);
  writeFileSync(transcriptPath, [
    { type: "user", cwd: canonicalCwd, message: { content: "swap" } },
    { type: "assistant", message: { model: "claude-opus-5", content: "native" } },
    { type: "assistant", message: { model: "gpt-5.6-sol", content: "gateway" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  const dbPath = join(root, "index.db");
  const db = openIndex(dbPath);
  db.query(`INSERT INTO sessions (
    session_id, host, path, cwd, project_root, project_name, fallback_label,
    file_mtime, file_size, resume_id, models, last_model
  ) VALUES (
    $id, 'host', $path, $cwd, $cwd, 'repo', 'stale row',
    1, 1, $id, '["claude-opus-5"]', 'claude-opus-5'
  )`).run({ $id: SESSION, $path: transcriptPath, $cwd: canonicalCwd });
  db.close();

  const bound: SurfaceSession = {
    sessionId: SESSION,
    workspaceId: WORKSPACE,
    cwd: canonicalCwd,
    transcriptPath,
    agentLifecycle: "running",
    isRestorable: true,
    pid: 4242,
    lastPermissionMode: "bypassPermissions",
  };
  const bridge: Bridge = {
    surfaces: [],
    activeWindowId: null,
    surfaceToWorkspace: new Map(),
    workspaceIds: () => [],
    surfacesInWorkspace: () => [],
    surfaceInfo: (surfaceId) => surfaceId === SURFACE ? bound : null,
    locateSession: () => null,
    isOpen: () => false,
    primarySurface: () => null,
    readable: true,
  };
  return { root, dbPath, cwd: canonicalCwd, transcriptPath, bridge };
}

function dependencies(
  bridge: Bridge,
  respawnIo: RespawnIo,
  errors: string[] = [],
): RespawnCommandDependencies {
  return {
    loadLauncherFleet: () => ok(FLEET),
    readBridge: () => bridge,
    respawnIo,
    environment: ENVIRONMENT,
    stdout: () => {},
    stderr: (message) => errors.push(message),
  };
}

test("swapHarnessCommand uses the current transcript when SQLite still reports the old harness", async () => {
  const f = fixture();
  const calls: Array<{ surfaceId: string; command: string }> = [];
  try {
    const exit = await swapHarnessCommand(["--do"], f.dbPath, dependencies(f.bridge, {
      respawn: (surfaceId, command) => {
        calls.push({ surfaceId, command });
        return { ok: true };
      },
    }));
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.surfaceId).toBe(SURFACE);
    expect(calls[0]!.command).toContain("claude-native --resume");
    expect(calls[0]!.command).toContain("--model opus");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("indexed row.path wins before a broad scan and is freshly parsed for harness and cwd", async () => {
  const f = fixture();
  const duplicateCwd = join(f.root, "enumerated-cwd");
  mkdirSync(duplicateCwd, { recursive: true });
  const canonicalDuplicateCwd = realpathSync(duplicateCwd);
  const duplicateDir = join(f.root, encodePath(canonicalDuplicateCwd));
  mkdirSync(duplicateDir, { recursive: true });
  const duplicatePath = join(duplicateDir, `${SESSION}.jsonl`);
  writeFileSync(duplicatePath, [
    { type: "user", cwd: canonicalDuplicateCwd, message: { content: "wrong duplicate" } },
    { type: "assistant", message: { model: "claude-opus-5", content: "native" } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");

  const bridge: Bridge = {
    ...f.bridge,
    surfaceInfo: (surfaceId) => {
      const bound = f.bridge.surfaceInfo(surfaceId);
      return bound ? { ...bound, transcriptPath: join(f.root, "missing-live.jsonl") } : null;
    },
  };
  const calls: string[] = [];
  let scans = 0;
  try {
    const exit = await swapHarnessCommand(["--do"], f.dbPath, {
      ...dependencies(bridge, {
        respawn: (_surfaceId, command) => {
          calls.push(command);
          return { ok: true };
        },
      }),
      scanForTranscript: (sessionId) => {
        expect(sessionId).toBe(SESSION);
        scans++;
        return duplicatePath;
      },
    });

    expect(exit).toBe(0);
    expect(scans).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`cd -- ${f.cwd} && claude-native --resume`);
    expect(calls[0]).toContain("--model opus");
    expect(calls[0]).not.toContain(canonicalDuplicateCwd);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("restartCommand uses the current transcript when SQLite still reports the old harness", async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    const exit = await restartCommand(["--do"], f.dbPath, dependencies(f.bridge, {
      respawn: (_surfaceId, command) => {
        calls.push(command);
        return { ok: true };
      },
    }));
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("claude-gpt --resume");
    expect(calls[0]).not.toContain("--model");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("--model --do and missing launcher values fail before liveness or respawn", async () => {
  let bridgeReads = 0;
  let respawns = 0;
  const errors: string[] = [];
  const deps: RespawnCommandDependencies = {
    loadLauncherFleet: () => ok(FLEET),
    readBridge: () => {
      bridgeReads++;
      throw new Error("must not read bridge");
    },
    respawnIo: {
      respawn: () => {
        respawns++;
        return { ok: true };
      },
    },
    environment: ENVIRONMENT,
    stdout: () => {},
    stderr: (message) => errors.push(message),
  };

  expect(await swapHarnessCommand(["--model", "--do"], ":memory:", deps)).toBe(1);
  expect(await restartCommand(["--on", "--do"], ":memory:", deps)).toBe(1);
  expect(bridgeReads).toBe(0);
  expect(respawns).toBe(0);
  expect(errors).toEqual([
    "ccs: --model requires a non-flag value",
    "ccs: --on requires a non-flag value",
  ]);
});

test("invalid model overrides fail validation with exit 1 and no destructive call", async () => {
  let bridgeReads = 0;
  let respawns = 0;
  const errors: string[] = [];
  const deps: RespawnCommandDependencies = {
    loadLauncherFleet: () => ok(FLEET),
    readBridge: () => {
      bridgeReads++;
      throw new Error("must not read bridge");
    },
    respawnIo: {
      respawn: () => {
        respawns++;
        return { ok: true };
      },
    },
    environment: ENVIRONMENT,
    stdout: () => {},
    stderr: (message) => errors.push(message),
  };

  const exit = await restartCommand(["--model", "gpt-5.6-sol[1m]", "--do"], ":memory:", deps);
  expect(exit).toBe(1);
  expect(bridgeReads).toBe(0);
  expect(respawns).toBe(0);
  expect(errors[0]).toContain("--model must be one of");
});

test("a planning refusal returns exit 1 without calling the destructive respawn seam", async () => {
  const f = fixture();
  let respawns = 0;
  const errors: string[] = [];
  try {
    const exit = await swapHarnessCommand(
      ["--to", "claude-gpt", "--do"],
      f.dbPath,
      dependencies(f.bridge, {
        respawn: () => {
          respawns++;
          return { ok: true };
        },
      }, errors),
    );
    expect(exit).toBe(1);
    expect(respawns).toBe(0);
    expect(errors[0]).toContain("already running on claude-gpt");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("unreadable liveness returns exit 2 without calling respawn", async () => {
  const f = fixture();
  const bridge: Bridge = { ...f.bridge, readable: false };
  let respawns = 0;
  const errors: string[] = [];
  try {
    const exit = await swapHarnessCommand(
      ["--do"],
      f.dbPath,
      dependencies(bridge, {
        respawn: () => {
          respawns++;
          return { ok: true };
        },
      }, errors),
    );
    expect(exit).toBe(2);
    expect(respawns).toBe(0);
    expect(errors).toEqual([
      "ccs: refusing to respawn — cmux liveness is unreadable — refusing to respawn blind",
    ]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("respawnIo.respawn failure returns exit 2", async () => {
  const f = fixture();
  let respawns = 0;
  const errors: string[] = [];
  try {
    const exit = await restartCommand(
      ["--do"],
      f.dbPath,
      dependencies(f.bridge, {
        respawn: () => {
          respawns++;
          return { ok: false, error: "cmux socket refused" };
        },
      }, errors),
    );
    expect(exit).toBe(2);
    expect(respawns).toBe(1);
    expect(errors).toEqual(["ccs: respawn failed — cmux socket refused"]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a valid canonical command override reaches respawn as current GPT launch spelling", async () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    const exit = await restartCommand(
      ["--model", "gpt-5.6-sol", "--do"],
      f.dbPath,
      dependencies(f.bridge, {
        respawn: (_surfaceId, command) => {
          calls.push(command);
          return { ok: true };
        },
      }),
    );
    expect(exit).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--model 'gpt-5.6-sol[1m]'");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
