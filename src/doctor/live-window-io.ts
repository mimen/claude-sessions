/**
 * Runs the live window check: one headless `claude -p` per picker model through the installed
 * launcher wrapper, with a debug file, and reads the effectiveWindow each run logs.
 *
 * The wrapper is launched exactly as a user would launch it, so the measurement covers the whole
 * chain: wrapper marker, generated settings, shim environment, Claude Code's own catalogue. Every
 * run is `--no-session-persistence`, so nothing is born. Any inherited context variable is
 * cleared first; otherwise a stale CLAUDE_CODE_AUTO_COMPACT_WINDOW in the caller's shell would
 * make every model read as the envelope and the check would pass for the wrong reason.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { requireModelRegistry, type ModelRegistry } from "../models/registry.ts";
import { runtimeRoot } from "../paths.ts";
import { err, ok, type Result } from "../result.ts";
import {
  liveWindowExpectations,
  parseEffectiveWindow,
  userWindowCeilings,
  type LiveWindowExpectation,
  type LiveWindowResult,
} from "./live-window.ts";

const INHERITED_CONTEXT_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_MODEL",
];

/** A reply this short keeps every run to one request and a few seconds. */
const PROMPT = "Reply with exactly: ok";
const RUN_TIMEOUT_MS = 180_000;

export interface LiveWindowOptions {
  readonly registry?: ModelRegistry;
  readonly launcher?: string;
  /** Restrict to these canonical ids; every picker model otherwise. */
  readonly only?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}

function runOne(wrapper: string, expectation: LiveWindowExpectation, environment: NodeJS.ProcessEnv): LiveWindowResult {
  const scratch = mkdtempSync(join(tmpdir(), "ccs-live-window-"));
  const debugFile = join(scratch, "debug.log");
  const env: NodeJS.ProcessEnv = { ...environment };
  for (const key of INHERITED_CONTEXT_KEYS) delete env[key];
  try {
    const run = Bun.spawnSync(
      [wrapper, "--model", expectation.declaration, "-p", "--no-session-persistence", "--debug-file", debugFile, PROMPT],
      { env, stdout: "pipe", stderr: "pipe", timeout: RUN_TIMEOUT_MS },
    );
    let log = "";
    try {
      log = readFileSync(debugFile, "utf8");
    } catch {
      log = "";
    }
    const observed = parseEffectiveWindow(log);
    if (observed === null && run.exitCode !== 0) {
      const detail = new TextDecoder().decode(run.stderr).trim().split("\n").pop() ?? "";
      return { ...expectation, observed: null, error: detail || `exit ${run.exitCode}` };
    }
    return { ...expectation, observed };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function collectLiveWindows(options: LiveWindowOptions = {}): Result<{
  readonly launcher: string;
  readonly results: readonly LiveWindowResult[];
}> {
  const registry = options.registry ?? requireModelRegistry();
  const launcher = options.launcher ?? "claudex";
  const wrapper = join(runtimeRoot(), "bin", launcher);
  const environment = options.environment ?? process.env;
  const home = environment.HOME ?? homedir();
  const settingsPath = join(environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "settings.json");
  let ceilings: Readonly<Record<string, number>> = {};
  try {
    ceilings = userWindowCeilings(readFileSync(settingsPath, "utf8"));
  } catch {
    ceilings = {};
  }
  let expectations = liveWindowExpectations(registry, launcher, ceilings);
  if (options.only && options.only.length > 0) {
    const wanted = new Set(options.only);
    expectations = expectations.filter((expectation) => wanted.has(expectation.model));
    if (expectations.length === 0) {
      return err(new Error(`none of ${options.only.join(", ")} is a picker model on ${launcher}`));
    }
  }
  if (expectations.length === 0) return err(new Error(`launcher ${launcher} offers no picker models`));
  const results = expectations.map((expectation) => runOne(wrapper, expectation, environment));
  return ok({ launcher, results });
}
