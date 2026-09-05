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
import type { Bridge } from "../cmux/bridge.ts";
import { liveBridge } from "../cmux/live.ts";
import { sessionById, type SessionRow } from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { parseSessionFile } from "../parse.ts";
import { type Result, err, ok } from "../result.ts";
import { resolveResumeCwd } from "./command.ts";
import { loadLaunchers, type Launcher } from "./launchers.ts";
import { encodesTo, locateLaunchDir, storageFolderOf } from "./locate.ts";
import { describeRestart, planRestart } from "./restart.ts";
import {
  runRespawn,
  type ModelHistory,
  type RespawnEnv,
  type RespawnIo,
  type RespawnPlan,
  type RespawnRefusal,
} from "./respawn.ts";
import { birthModelIds, parseBirthModel } from "./role-model-launch.ts";
import { describeSwap, planSwap } from "./swap-harness.ts";

interface ParsedRespawnArgs {
  readonly perform: boolean;
  readonly target?: string;
  readonly model?: string;
}

/** Strictly parse the small command surface before probing liveness or constructing a plan. */
function parseRespawnArgs(
  args: readonly string[],
  targetFlag: "--to" | "--on",
): Result<ParsedRespawnArgs, Error> {
  let perform = false;
  let target: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--do") {
      if (perform) return err(new Error("--do may be specified only once"));
      perform = true;
      continue;
    }
    if (arg !== targetFlag && arg !== "--model") {
      return err(new Error(`unknown argument "${arg}"`));
    }

    const value = args[i + 1];
    if (!value || value.startsWith("-")) {
      return err(new Error(`${arg} requires a non-flag value`));
    }
    i++;

    if (arg === targetFlag) {
      if (target !== undefined) return err(new Error(`${targetFlag} may be specified only once`));
      target = value;
      continue;
    }

    if (model !== undefined) return err(new Error("--model may be specified only once"));
    if (!parseBirthModel(value)) {
      return err(new Error(`--model must be one of: ${birthModelIds().join(", ")}`));
    }
    model = value;
  }

  return ok({
    perform,
    ...(target === undefined ? {} : { target }),
    ...(model === undefined ? {} : { model }),
  });
}

/**
 * Find a session's transcript without the index — `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`.
 * Needed because a session becomes respawnable the moment it starts, long before it is indexed.
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

function indexedRow(sessionId: string, dbPath: string): SessionRow | null {
  const db = openIndex(dbPath);
  try {
    return sessionById(db, sessionId);
  } finally {
    db.close();
  }
}

interface RespawnEvidence {
  readonly history: ModelHistory;
  readonly resumeCwd: string;
}

/**
 * Read the current process's transcript directly before inferring its harness. The index remains a
 * useful path/cwd fallback, but never supplies model history here: a just-swapped session can append
 * a new-provider turn before the incremental index notices the file change.
 */
async function currentRespawnEvidence(
  sessionId: string,
  surfaceId: string | null,
  bridge: Bridge,
  dbPath: string,
  scanForTranscript: (sessionId: string) => string | null,
): Promise<Result<RespawnEvidence, Error>> {
  const bound = surfaceId ? bridge.surfaceInfo(surfaceId) : null;
  const processTranscript = bound?.sessionId === sessionId ? bound.transcriptPath : null;
  let row: SessionRow | null = null;
  let readError: Error | null = null;
  const attempted = new Set<string>();

  const parseCandidate = async (
    candidate: string | null | undefined,
  ): Promise<{
    readonly path: string;
    readonly parsed: Awaited<ReturnType<typeof parseSessionFile>>;
  } | null> => {
    if (!candidate || attempted.has(candidate)) return null;
    attempted.add(candidate);
    if (!existsSync(candidate)) return null;
    try {
      return { path: candidate, parsed: await parseSessionFile(candidate, sessionId) };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      readError = new Error(`cannot read current transcript: ${message}`);
      return null;
    }
  };

  // Prefer the live hook's exact file. If it is absent or unreadable, the index's canonical path is
  // the next-best locator — but parse that file now, never trust the row's cached model fields.
  // Only enumerate the broad projects tree after both precise locators fail.
  let transcript = await parseCandidate(processTranscript);
  if (!transcript) {
    row = indexedRow(sessionId, dbPath);
    transcript = await parseCandidate(row?.path);
  }
  transcript ??= await parseCandidate(scanForTranscript(sessionId));
  if (!transcript) {
    return readError ? err(readError) : err(new Error(`no transcript found for session ${sessionId}`));
  }
  const { path, parsed } = transcript;

  let resumeCwd: string | null = null;
  if (parsed.cwd && existsSync(parsed.cwd) && encodesTo(parsed.cwd, storageFolderOf(path))) {
    resumeCwd = parsed.cwd;
  } else {
    const located = locateLaunchDir(path);
    if (!located.ok) return err(new Error(`cannot locate launch directory: ${located.error.message}`));
    resumeCwd = located.value?.dir ?? null;
  }

  // Preserve the established missing-anchor/project fallback when an indexed row exists, but make
  // it resolve against the exact transcript and freshly parsed cwd rather than stale index facts.
  if (!resumeCwd) row ??= indexedRow(sessionId, dbPath);
  if (!resumeCwd && row) {
    const resolved = resolveResumeCwd({ ...row, path, cwd: parsed.cwd ?? row.cwd });
    if ("error" in resolved) return err(new Error(resolved.error));
    resumeCwd = resolved.cwd;
  }
  if (!resumeCwd) return err(new Error(`no existing directory encodes to ${path}`));

  return ok({
    history: {
      models: parsed.usage.models,
      lastModel: parsed.usage.lastModel ?? "",
    },
    resumeCwd,
  });
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
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  };
}

export interface RespawnCommandDependencies {
  readonly loadLauncherFleet?: () => Result<Launcher[]>;
  readonly readBridge?: () => Bridge;
  readonly scanForTranscript?: (sessionId: string) => string | null;
  readonly respawnIo?: RespawnIo;
  readonly environment?: RespawnEnv;
  readonly stdout?: (message: string) => void;
  readonly stderr?: (message: string) => void;
}

interface RespawnPlanInput {
  readonly environment: RespawnEnv;
  readonly history: ModelHistory;
  readonly resumeCwd: string | undefined;
  readonly launchers: readonly Launcher[];
  readonly bridge: Bridge;
}

/** Shared shell: gather fresh state, plan via the caller's planner, print, and optionally fire. */
async function respawnCommand(
  parsedArgs: ParsedRespawnArgs,
  dbPath: string,
  plan: (input: RespawnPlanInput) => Result<RespawnPlan, RespawnRefusal>,
  describe: (plan: RespawnPlan) => string,
  dependencies: RespawnCommandDependencies,
): Promise<number> {
  const writeOut = dependencies.stdout ?? ((message: string): void => console.log(message));
  const writeErr = dependencies.stderr ?? ((message: string): void => console.error(message));
  const launcherResult = (dependencies.loadLauncherFleet ?? loadLaunchers)();
  if (!launcherResult.ok) {
    writeErr(`ccs: ${launcherResult.error.message}`);
    return 1;
  }

  const environment = dependencies.environment ?? {
    sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    surfaceId: process.env.CMUX_SURFACE_ID ?? null,
    workspaceId: process.env.CMUX_WORKSPACE_ID ?? null,
  };
  const bridge = (dependencies.readBridge ?? liveBridge)();

  let history: ModelHistory = { models: [], lastModel: "" };
  let resumeCwd: string | undefined;
  if (environment.sessionId) {
    const evidence = await currentRespawnEvidence(
      environment.sessionId,
      environment.surfaceId,
      bridge,
      dbPath,
      dependencies.scanForTranscript ?? findTranscript,
    );
    if (!evidence.ok) {
      writeErr(`ccs: refusing to respawn — ${evidence.error.message}`);
      return 1;
    }
    history = evidence.value.history;
    resumeCwd = evidence.value.resumeCwd;
  }

  const planned = plan({
    environment,
    history,
    resumeCwd,
    launchers: launcherResult.value,
    bridge,
  });
  if (!planned.ok) {
    writeErr(`ccs: refusing to respawn — ${planned.error.message}`);
    return planned.error.code === "liveness-unreadable" ? 2 : 1;
  }

  writeOut(describe(planned.value));
  if (!parsedArgs.perform) {
    writeOut("\npreflight only — pass --do to run it");
    return 0;
  }

  // Past this point cmux hangs up this very process, so nothing below is guaranteed to print.
  const done = runRespawn(planned.value, dependencies.respawnIo ?? cmuxIo());
  if (!done.ok) {
    writeErr(`ccs: respawn failed — ${done.error.message}`);
    return 2;
  }
  return 0;
}

export async function swapHarnessCommand(
  args: string[],
  dbPath: string,
  dependencies: RespawnCommandDependencies = {},
): Promise<number> {
  const parsed = parseRespawnArgs(args, "--to");
  const writeErr = dependencies.stderr ?? ((message: string): void => console.error(message));
  if (!parsed.ok) {
    writeErr(`ccs: ${parsed.error.message}`);
    return 1;
  }
  return respawnCommand(
    parsed.value,
    dbPath,
    ({ environment, history, resumeCwd, launchers, bridge }) =>
      planSwap(environment, bridge, launchers, history, {
        to: parsed.value.target,
        model: parsed.value.model,
        resumeCwd,
      }),
    describeSwap,
    dependencies,
  );
}

export async function restartCommand(
  args: string[],
  dbPath: string,
  dependencies: RespawnCommandDependencies = {},
): Promise<number> {
  const parsed = parseRespawnArgs(args, "--on");
  const writeErr = dependencies.stderr ?? ((message: string): void => console.error(message));
  if (!parsed.ok) {
    writeErr(`ccs: ${parsed.error.message}`);
    return 1;
  }
  return respawnCommand(
    parsed.value,
    dbPath,
    ({ environment, history, resumeCwd, launchers, bridge }) =>
      planRestart(environment, bridge, launchers, history, {
        on: parsed.value.target,
        model: parsed.value.model,
        resumeCwd,
      }),
    describeRestart,
    dependencies,
  );
}
