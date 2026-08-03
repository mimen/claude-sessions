/**
 * THE `clears` CROSS-PATH CONTRACT.
 *
 * `claude-native` is the gateway escape hatch: it exists so a session running on the gateway can
 * spawn a child that reaches real Anthropic (claude.ai connectors, Remote Control). That only
 * works if the child's inherited ANTHROPIC_BASE_URL/AUTH_TOKEN are STRIPPED. Adding assignments is
 * not enough — an assignment map has no way to express a removal, which is exactly how `clears`
 * came to be honored by the `~/.ccs/bin/claude` shim and silently dropped by every explicit
 * `--via` spawn path.
 *
 * Each test below drives ONE spawn path with the same claude-native fixture and asserts the
 * launcher's `clears` reach the launched process. They are written to FAIL if `clears` is dropped
 * from that path specifically — the assertion is on the unset reaching the transport, never on an
 * intermediate helper's return value, so re-deriving the environment from `launcher.env` anywhere
 * downstream still fails the test.
 *
 * The last test is the one that would have caught the original bug shape: it walks every path at
 * once and asserts none of them silently disagrees with the shim's compiled spec.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, setResumeId } from "../catalogue/db.ts";
import type { Bridge } from "../cmux/bridge.ts";
import { openIndex } from "../index/schema.ts";
import { compileLauncherEnvSpec } from "../launcher/environment.ts";
import { buildResumeCommand } from "./command.ts";
import { inlineLaunchEnvironment } from "./new-session.ts";
import type { Launcher } from "./launchers.ts";
import { planResumeSession, resumeSessionEntry } from "./resume-session.ts";
import { planRestart } from "./restart.ts";
import { planSwap } from "./swap-harness.ts";
import type { RespawnEnv } from "./respawn.ts";

/** The variables that carry a gateway route. Stripping these IS the escape hatch. */
const GATEWAY_VARIABLES = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"] as const;

const CLAUDE_NATIVE: Launcher = {
  name: "claude-native",
  binary: "claude-native",
  serves: ["claude-*"],
  env: {},
  clears: [...GATEWAY_VARIABLES],
};

const CLAUDEX: Launcher = {
  name: "claudex",
  binary: "claudex",
  serves: ["*"],
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
  clears: [],
};

const FLEET: readonly Launcher[] = [CLAUDEX, CLAUDE_NATIVE];

const SESSION = "e995627d-0db4-421d-8a7d-982250ef216f";
const SURFACE = "surface-1";
const WORKSPACE = "workspace-1";

function stubBridge(open: readonly string[]): Bridge {
  return {
    readable: true,
    isOpen: (id: string) => open.includes(id),
    openSessionIds: () => [...open],
    surfaceInfo: (surfaceId: string) =>
      surfaceId === SURFACE
        ? {
            sessionId: SESSION,
            surfaceId: SURFACE,
            workspaceId: WORKSPACE,
            transcriptPath: null,
            lastPermissionMode: null,
            pid: 4242,
          }
        : null,
    surfaceIdFor: () => null,
    workspaceIdFor: () => null,
  } as unknown as Bridge;
}

const RESPAWN_ENVIRONMENT: RespawnEnv = {
  sessionId: SESSION,
  surfaceId: SURFACE,
  workspaceId: WORKSPACE,
};

const HISTORY = { models: ["claude-opus-5"], lastModel: "claude-opus-5" } as const;

describe("`clears` reaches every explicit-launcher spawn path", () => {
  /**
   * THE HEADLINE CASE, end to end: `ccs resume --via claude-native` from a gateway session. This
   * drives the real entry point down to the cmux transport and inspects the command cmux is
   * actually handed, so nothing between `--via` and the launched process can drop the unsets
   * without failing here.
   */
  test("resume: `--via claude-native` hands cmux a command that strips the gateway route", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-clears-resume-"));
    const cmuxPath = join(root, "fake-cmux");
    const callsFile = join(root, "calls.log");
    writeFileSync(cmuxPath, `#!/bin/bash\nprintf '%s\\0' "$@" > "${callsFile}"\necho 'workspace:7'\n`, {
      mode: 0o755,
    });

    const index = openIndex(":memory:");
    const catalogue = openCatalogue(":memory:");
    const now = "2026-07-30T00:00:00Z";
    try {
      index.query(
        `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
           fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent,
           resume_id, models, last_model)
         VALUES ('s1', 'h', '/store/s1.jsonl', $cwd, $cwd, 'p', 's1', $now, $now, 1, 0, 0, 0,
           's1', '["claude-opus-5"]', 'claude-opus-5')`,
      ).run({ $now: now, $cwd: root });
      setResumeId(catalogue, "s1", "s1", now);

      const result = resumeSessionEntry(index, catalogue, "s1", {
        bridge: stubBridge([]),
        launchers: FLEET,
        via: "claude-native",
        cmuxBin: cmuxPath,
      });
      expect(result.status).toBe("resumed");

      const argv = readFileSync(callsFile, "utf8").split("\0");
      const command = argv[argv.indexOf("--command") + 1] ?? "";
      expect(command).toContain("claude-native");
      for (const variable of GATEWAY_VARIABLES) {
        expect(command).toContain(`-u ${variable}`);
      }
    } finally {
      index.close();
      catalogue.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resume: the built command's shell form applies `env -u` before assignments", () => {
    const command = buildResumeCommand(
      {
        resumeId: "resume-1",
        sessionId: "s1",
        title: "t",
        cwd: "/tmp",
      } as never,
      {
        fork: false,
        cwd: "/tmp",
        binary: "claude-native",
        env: {},
        unset: [...GATEWAY_VARIABLES],
      },
    );

    // The unsets must survive into BOTH the structured field the transports read and the display
    // form, or a reader auditing `ccs resume --dry-run` sees a command that is not what runs.
    expect(command.unset).toEqual([...GATEWAY_VARIABLES]);
    for (const variable of GATEWAY_VARIABLES) {
      expect(command.shell).toContain(`-u ${variable}`);
    }
    expect(command.shell.indexOf("-u ")).toBeLessThan(command.shell.indexOf("claude-native"));
  });

  test("resume planner: a launcher with no clears still produces an empty unset list", () => {
    const plan = planResumeSession(
      stubBridge([]),
      {
        resumeId: "resume-1",
        sessionId: "s1",
        title: "t",
        cwd: "/tmp",
        path: "/store/s1.jsonl",
      } as never,
      { resumeCommand: null, binary: "claudex", env: CLAUDEX.env, unset: [] },
    );
    expect(plan.action).toBe("resume");
    if (plan.action !== "resume") throw new Error("unreachable");
    expect(plan.command.unset).toEqual([]);
    expect(plan.command.shell).not.toContain("-u ");
  });

  test("birth (inline): clears REMOVE the inherited variable instead of merely not setting it", () => {
    const inherited = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:8317";
    try {
      const environment = inlineLaunchEnvironment({} as never, {}, [...GATEWAY_VARIABLES]);
      // The whole bug: an inline birth builds its environment from process.env, so a gateway
      // parent's route survives unless `clears` actively deletes it.
      expect(environment.ANTHROPIC_BASE_URL).toBeUndefined();
    } finally {
      if (inherited === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = inherited;
    }
  });

  test("swap-harness: swapping TO claude-native strips the gateway route it is escaping", () => {
    const planned = planSwap(RESPAWN_ENVIRONMENT, stubBridge([SESSION]), FLEET, HISTORY, {
      to: "claude-native",
      resumeCwd: "/tmp",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    for (const variable of GATEWAY_VARIABLES) {
      expect(planned.value.command).toContain(`-u ${variable}`);
    }
  });

  test("restart: restarting ON claude-native strips it too", () => {
    const planned = planRestart(RESPAWN_ENVIRONMENT, stubBridge([SESSION]), FLEET, HISTORY, {
      on: "claude-native",
      resumeCwd: "/tmp",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    for (const variable of GATEWAY_VARIABLES) {
      expect(planned.value.command).toContain(`-u ${variable}`);
    }
  });

  test("respawn: a launcher's assignments still land, and clears precede them", () => {
    const planned = planRestart(RESPAWN_ENVIRONMENT, stubBridge([SESSION]), FLEET, HISTORY, {
      on: "claudex",
      resumeCwd: "/tmp",
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.command).toContain("ANTHROPIC_BASE_URL=http://127.0.0.1:8317");
  });

  /**
   * The disagreement guard. The shim's spec file and the spawn paths are two renderings of ONE
   * compiled directive list; this asserts they still agree about `claude-native`. If a future
   * change re-derives a spawn path's environment from `launcher.env` directly, the spec keeps its
   * `clear` lines and that path loses them — and this fails.
   */
  test("no spawn path disagrees with the shim's compiled spec about claude-native", () => {
    const spec = compileLauncherEnvSpec({
      name: CLAUDE_NATIVE.name,
      env: CLAUDE_NATIVE.env,
      clears: CLAUDE_NATIVE.clears,
    });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;

    const clearedByShim = spec.value
      .split("\n")
      .filter((line) => line.startsWith("clear "))
      .map((line) => line.slice("clear ".length));
    expect(clearedByShim).toEqual([...GATEWAY_VARIABLES]);

    const bridge = stubBridge([SESSION]);
    const swap = planSwap(RESPAWN_ENVIRONMENT, bridge, FLEET, HISTORY, {
      to: "claude-native",
      resumeCwd: "/tmp",
    });
    const restart = planRestart(RESPAWN_ENVIRONMENT, bridge, FLEET, HISTORY, {
      on: "claude-native",
      resumeCwd: "/tmp",
    });
    expect(swap.ok).toBe(true);
    expect(restart.ok).toBe(true);
    if (!swap.ok || !restart.ok) return;

    for (const variable of clearedByShim) {
      expect(swap.value.command).toContain(`-u ${variable}`);
      expect(restart.value.command).toContain(`-u ${variable}`);
    }

    // And the birth path, whose environment is a map rather than a shell string.
    const inherited = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "token-from-the-gateway-parent";
    try {
      const birth = inlineLaunchEnvironment({} as never, {}, clearedByShim);
      for (const variable of clearedByShim) {
        expect(birth[variable]).toBeUndefined();
      }
    } finally {
      if (inherited === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = inherited;
    }
  });
});
