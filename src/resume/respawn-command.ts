/**
 * CLI entry points for the two in-place respawn verbs:
 *
 *   ccs swap-harness [--to <launcher>] [--model <m>] [--do]   → the OTHER harness
 *   ccs restart      [--on <launcher>] [--model <m>] [--do]   → the SAME one, fresh process
 *
 * Both are two-phase like `close-current-workspace`: the bare form proves identity and prints
 * exactly what it would run; `--do` performs it. The phases matter more here than usual, because
 * the acting process is also the victim — once `--do` fires there is no chance to report anything.
 *
 * Exit codes:
 *   0   preflight authorized (bare) / respawn requested (--do)
 *   1   refused — the reason is printed and nothing was touched
 *   2   liveness unreadable, or cmux rejected the respawn (fail-closed)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { liveBridge } from "../cmux/live.ts";
import { sessionById } from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { resolveResumeCwd } from "./command.ts";
import { loadLaunchers } from "./launchers.ts";
import { locateLaunchDir } from "./locate.ts";
import { describeRestart, planRestart } from "./restart.ts";
import { runRespawn, type ModelHistory, type RespawnIo, type RespawnPlan } from "./respawn.ts";
import { describeSwap, planSwap } from "./swap-harness.ts";

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Find a session's transcript without the index — `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
 * Needed because a session becomes respawnable the moment it starts, long before it is indexed,
 * and the transcript's own location is the only authority on which directory `--resume` works
 * from.
 */
function findTranscript(sessionId: string): string | null {
  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return null;
  for (const folder of readdirSync(projects)) {
    const candidate = join(projects, folder, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The directory the respawned process must start in.
 *
 * NEVER cmux's recorded cwd: its hooks track where the session currently is, which drifts as the
 * agent cd's around, while the transcript stays filed under the launch directory. Relaunching from
 * a drifted cwd is exactly the "No conversation found with session ID" failure.
 */
function resolveRespawnCwd(sessionId: string, dbPath: string): { cwd: string } | { error: string } {
  const db = openIndex(dbPath);
  try {
    const row = sessionById(db, sessionId);
    // The indexed path gets the full treatment: verify the recorded cwd still encodes to the
    // transcript's storage folder, and walk for the right directory when it doesn't.
    if (row) return resolveResumeCwd(row);
  } finally {
    db.close();
  }
  const path = findTranscript(sessionId);
  if (!path) return { error: `no transcript found for session ${sessionId}` };
  const located = locateLaunchDir(path);
  if (!located.ok) return { error: `cannot locate launch directory: ${located.error.message}` };
  if (!located.value) return { error: `no existing directory encodes to ${path}` };
  return { cwd: located.value.dir };
}

/** Real cmux IO. `respawn-pane` is a socket call to the cmux app, so it outlives this process. */
function cmuxIo(): RespawnIo {
  return {
    respawn(surfaceId, command) {
      try {
        execFileSync(
          process.env.CMUX_BIN ?? "cmux",
          ["respawn-pane", "--surface", surfaceId, "--command", command],
          { stdio: "pipe", timeout: 10_000 },
        );
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

/** Shared shell: gather state, plan via the caller's planner, print, and optionally fire. */
function respawnCommand(
  args: string[],
  dbPath: string,
  plan: (input: {
    sessionId: string | null;
    history: ModelHistory;
    resumeCwd: string | undefined;
    launchers: readonly import("./launchers.ts").Launcher[];
  }) => ReturnType<typeof planSwap>,
  describe: (p: RespawnPlan) => string,
): number {
  const launchers = loadLaunchers();
  if (!launchers.ok) {
    console.error(`ccs: ${launchers.error.message}`);
    return 1;
  }

  const sessionId = process.env.CLAUDE_CODE_SESSION_ID ?? null;
  // A missing index row is normal, not an error — it only costs the ability to infer the origin
  // harness, which each planner handles in its own way.
  let history: ModelHistory = { models: [], lastModel: "" };
  let resumeCwd: string | undefined;
  if (sessionId) {
    const db = openIndex(dbPath);
    try {
      const row = sessionById(db, sessionId);
      if (row) history = { models: row.models, lastModel: row.lastModel };
    } finally {
      db.close();
    }
    const resolved = resolveRespawnCwd(sessionId, dbPath);
    if ("error" in resolved) {
      console.error(`ccs: refusing to respawn — ${resolved.error}`);
      return 1;
    }
    resumeCwd = resolved.cwd;
  }

  const planned = plan({ sessionId, history, resumeCwd, launchers: launchers.value });
  if (!planned.ok) {
    console.error(`ccs: refusing to respawn — ${planned.error.message}`);
    return planned.error.code === "liveness-unreadable" ? 2 : 1;
  }

  console.log(describe(planned.value));
  if (!args.includes("--do")) {
    console.log("\npreflight only — pass --do to run it");
    return 0;
  }

  // Past this point cmux hangs up this very process, so nothing below is guaranteed to print.
  const done = runRespawn(planned.value, cmuxIo());
  if (!done.ok) {
    console.error(`ccs: respawn failed — ${done.error.message}`);
    return 2;
  }
  return 0;
}

const envOf = (sessionId: string | null) => ({
  sessionId,
  surfaceId: process.env.CMUX_SURFACE_ID ?? null,
  workspaceId: process.env.CMUX_WORKSPACE_ID ?? null,
});

export function swapHarnessCommand(args: string[], dbPath: string): number {
  return respawnCommand(
    args,
    dbPath,
    ({ sessionId, history, resumeCwd, launchers }) =>
      planSwap(envOf(sessionId), liveBridge(), launchers, history, {
        to: flagValue(args, "--to"),
        model: flagValue(args, "--model"),
        resumeCwd,
      }),
    describeSwap,
  );
}

export function restartCommand(args: string[], dbPath: string): number {
  return respawnCommand(
    args,
    dbPath,
    ({ sessionId, history, resumeCwd, launchers }) =>
      planRestart(envOf(sessionId), liveBridge(), launchers, history, {
        on: flagValue(args, "--on"),
        model: flagValue(args, "--model"),
        resumeCwd,
      }),
    describeRestart,
  );
}
