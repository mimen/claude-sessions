import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { err, ok, type Result } from "../result.ts";
import {
  bunAsyncProcessAdapter,
  type AsyncProcessAdapter,
} from "../process/async.ts";
import { shellQuote } from "./command.ts";

/**
 * The ONE primitive for spawning a `claude` invocation into a fresh, detached cmux workspace.
 * Shared by resume (resumeSessionEntry), TUI resume (openInCmux), and new-session (spawnDetached)
 * so every new-workspace launch is constructed identically.
 *
 * IMPORTANT (cmux 0.64 tracking): the launcher argv runs as a PLAIN command in the new
 * workspace's integrated shell, so cmux's `claude` shim wraps it and its hooks register the
 * session in ~/.cmuxterm/claude-hook-sessions.json (surfaceId → sessionId). Explicit launcher env
 * is transported through a protected, single-use source file instead of cmux workspace env or the
 * command text. The integrated shell sources that file only inside a subshell, deletes the task's
 * file and directory before starting the launcher, and gives only the real names to the launcher
 * through `env`. A restored workspace therefore has neither values nor a reusable transport. An
 * independent no-secret janitor removes an unconsumed transport after 30 seconds, and each launch
 * prunes stale task-owned transports left by an interrupted process.
 * We deliberately DO NOT `exec` or scrub CMUX_SURFACE_ID/CMUX_WORKSPACE_ID: the cmux shim needs
 * those to bind the session to its surface.
 */

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STAGING_ENV_PREFIX = "CCS_CMUX_STAGED_ENV_";
const TEMP_DIRECTORY_PREFIX = "ccs-cmux-launch-";
const TEMP_ENVIRONMENT_FILE = "environment.sh";
const TEMP_CLEANUP_DELAY_MS = 30_000;
const STALE_TEMPORARY_ENVIRONMENT_AGE_MS = 5 * 60_000;

export interface CmuxNewWorkspaceOpts {
  /** Launcher argv to shell-quote into cmux's integrated-shell command. */
  readonly argv: readonly string[];
  /** cwd for the new workspace (the resolved anchor dir). */
  readonly cwd: string;
  /** cmux workspace name/title. */
  readonly name: string;
  /** Focus the new workspace after creating it (TUI/interactive resume wants this; a batch
   * cluster resume of many panes generally does not). Default false. */
  readonly focus?: boolean;
  /** Explicit launcher environment, scoped only to the launcher child. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Inherited variables the launcher child must NOT see (the launcher's `clears`). Applied as
   * `env -u` alongside the assignments, because the detached cmux shell inherits its parent's
   * environment and an assignment map has no way to say "remove this".
   */
  readonly unset?: readonly string[];
}

export interface SpawnCmuxOpts extends CmuxNewWorkspaceOpts {
  readonly cmuxBin?: string;
}

interface StagedEnvironmentEntry {
  readonly key: string;
  readonly value: string;
  readonly stagingKey: string;
}

interface TemporaryEnvironment {
  readonly directoryPath: string;
  readonly filePath: string;
}

interface PreparedCmuxInvocation {
  readonly argv: readonly string[];
  readonly temporaryEnvironment: TemporaryEnvironment | null;
}

interface CmuxInvocationOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function cleanupTemporaryEnvironment(temporaryEnvironment: TemporaryEnvironment): void {
  // Remove only the exact task-owned file, then its directory if empty. Never recursively remove
  // a temp path: an unexpected extra entry must fail closed rather than broaden cleanup scope.
  try {
    rmSync(temporaryEnvironment.filePath, { force: true });
  } catch {
    // Best effort: the integrated shell may already have consumed it.
  }
  try {
    rmdirSync(temporaryEnvironment.directoryPath);
  } catch {
    // Best effort: leave an unexpected non-empty directory untouched.
  }
}

function cleanupStaleTemporaryEnvironments(rootPath: string, now = Date.now()): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(TEMP_DIRECTORY_PREFIX) || !entry.isDirectory()) continue;
    const directoryPath = join(rootPath, entry.name);
    try {
      const metadata = lstatSync(directoryPath);
      if (!metadata.isDirectory()) continue;
      if (now - metadata.mtimeMs < STALE_TEMPORARY_ENVIRONMENT_AGE_MS) continue;
    } catch {
      continue;
    }
    cleanupTemporaryEnvironment({
      directoryPath,
      filePath: join(directoryPath, TEMP_ENVIRONMENT_FILE),
    });
  }
}

function scheduleTemporaryEnvironmentCleanup(
  temporaryEnvironment: TemporaryEnvironment,
  delayMs: number,
): boolean {
  const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
  const filePath = shellQuote(temporaryEnvironment.filePath);
  const directoryPath = shellQuote(temporaryEnvironment.directoryPath);
  try {
    const cleanup = Bun.spawn(
      [
        "/bin/sh",
        "-c",
        `/bin/sleep ${delaySeconds}; /bin/rm -f -- ${filePath}; ` +
          `/bin/rmdir -- ${directoryPath} 2>/dev/null || true`,
      ],
      {
        env: {},
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    cleanup.unref();
    return true;
  } catch {
    return false;
  }
}

function createTemporaryEnvironment(
  staged: readonly StagedEnvironmentEntry[],
  cleanupDelayMs: number,
): Result<TemporaryEnvironment> {
  let directoryPath: string | null = null;
  try {
    const temporaryRoot = resolve(tmpdir());
    cleanupStaleTemporaryEnvironments(temporaryRoot);
    directoryPath = mkdtempSync(join(temporaryRoot, TEMP_DIRECTORY_PREFIX));
    chmodSync(directoryPath, 0o700);
    const filePath = join(directoryPath, TEMP_ENVIRONMENT_FILE);
    const contents = `${staged
      .map((entry) => `${entry.stagingKey}=${shellQuote(entry.value)}`)
      .join("\n")}\n`;
    writeFileSync(filePath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    chmodSync(filePath, 0o600);
    const temporaryEnvironment = { directoryPath, filePath };
    if (!scheduleTemporaryEnvironmentCleanup(temporaryEnvironment, cleanupDelayMs)) {
      cleanupTemporaryEnvironment(temporaryEnvironment);
      return err(new Error("failed to schedule launcher environment cleanup"));
    }
    return ok(temporaryEnvironment);
  } catch {
    if (directoryPath !== null) {
      cleanupTemporaryEnvironment({
        directoryPath,
        filePath: join(directoryPath, TEMP_ENVIRONMENT_FILE),
      });
    }
    return err(new Error("failed to create protected launcher environment transport"));
  }
}

function prepareCmuxInvocation(
  opts: CmuxNewWorkspaceOpts,
  cleanupDelayMs: number,
): Result<PreparedCmuxInvocation> {
  const environment = Object.entries(opts.env ?? {});
  const unset = opts.unset ?? [];
  for (const [key] of environment) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      return err(new Error(`invalid launcher environment key: ${JSON.stringify(key)}`));
    }
  }
  for (const key of unset) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      return err(new Error(`invalid launcher environment key: ${JSON.stringify(key)}`));
    }
  }

  const launcher = opts.argv.map(shellQuote).join(" ");
  // `-u` flags precede assignments so a launcher may clear a family and re-assert one member, the
  // same order the compiled directive list guarantees.
  const unsetFlags = unset.map((key) => `-u ${key}`);
  let command = unsetFlags.length > 0 ? `/usr/bin/env ${unsetFlags.join(" ")} ${launcher}` : launcher;
  let temporaryEnvironment: TemporaryEnvironment | null = null;

  if (environment.length > 0) {
    const realKeys = new Set(environment.map(([key]) => key));
    let nextStagingIndex = 0;
    const staged: StagedEnvironmentEntry[] = environment.map(([key, value]) => {
      while (realKeys.has(`${STAGING_ENV_PREFIX}${nextStagingIndex}`)) nextStagingIndex++;
      const stagingKey = `${STAGING_ENV_PREFIX}${nextStagingIndex}`;
      nextStagingIndex++;
      return { key, value, stagingKey };
    });

    const created = createTemporaryEnvironment(staged, cleanupDelayMs);
    if (!created.ok) return created;
    temporaryEnvironment = created.value;

    const stagingKeys = staged.map((entry) => entry.stagingKey).join(" ");
    const realAssignments = staged.map((entry) => `${entry.key}="$${entry.stagingKey}"`);
    const sourceFile = shellQuote(temporaryEnvironment.filePath);
    const removeDirectory = shellQuote(temporaryEnvironment.directoryPath);
    command =
      `(set +a; unset ${stagingKeys}; builtin . ${sourceFile} && ` +
      `/bin/rm -f -- ${sourceFile} && ` +
      `{ /bin/rmdir -- ${removeDirectory} 2>/dev/null || true; } && ` +
      `/usr/bin/env ${[...unsetFlags, ...realAssignments].join(" ")} ${launcher})`;
  }

  const argv = ["new-workspace", "--cwd", opts.cwd, "--name", opts.name, "--command", command];
  if (opts.focus) argv.push("--focus", "true");
  return ok({ argv, temporaryEnvironment });
}

/**
 * Invoke cmux through the shared single-use environment transport. A failed cmux call cleans only
 * this invocation's exact temp file and empty directory. A successful return proves workspace
 * creation, matching cmux's receipt contract; the shell consumes the transport before launch, or
 * the independent janitor removes it without exposing values through workspace state.
 */
export function invokeCmuxNewWorkspace(
  opts: SpawnCmuxOpts,
  timeoutMs: number,
  cleanupDelayMs = TEMP_CLEANUP_DELAY_MS,
): CmuxInvocationOutput | null {
  const prepared = prepareCmuxInvocation(opts, cleanupDelayMs);
  if (!prepared.ok) return null;

  const cmux = opts.cmuxBin ?? process.env.CMUX_BIN ?? "cmux";
  try {
    const result = Bun.spawnSync([cmux, ...prepared.value.argv], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    if (!result.success) {
      if (prepared.value.temporaryEnvironment !== null) {
        cleanupTemporaryEnvironment(prepared.value.temporaryEnvironment);
      }
      return null;
    }
    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch {
    if (prepared.value.temporaryEnvironment !== null) {
      cleanupTemporaryEnvironment(prepared.value.temporaryEnvironment);
    }
    return null;
  }
}

function workspaceRefFromOutput(output: CmuxInvocationOutput): string | null {
  // Parse the workspace ref: JSON-first (look for a ref or id field), then regex fallback
  // to preserve current behavior if cmux returns plain text. Current 0.64.20 prints text,
  // so the regex is the live path; the JSON parse future-proofs for structured output.
  try {
    const json = JSON.parse(output.stdout) as { readonly ref?: string; readonly id?: string };
    if (json.ref) return json.ref;
    if (json.id) return json.id;
  } catch {
    // Not JSON, fall through to regex.
  }

  const combined = output.stdout + output.stderr;
  return combined.match(/workspace:[0-9]+/)?.[0] ?? null;
}

/** The new workspace ref (e.g. "workspace:60") on success, or null on any failure. */
export function spawnCmux(opts: SpawnCmuxOpts): string | null {
  const output = invokeCmuxNewWorkspace(opts, 10000);
  return output === null ? null : workspaceRefFromOutput(output);
}

/** Async sidebar/action variant with the same workspace receipt and environment cleanup contract. */
export async function spawnCmuxAsync(
  opts: SpawnCmuxOpts,
  processAdapter: AsyncProcessAdapter = bunAsyncProcessAdapter,
): Promise<string | null> {
  const prepared = prepareCmuxInvocation(opts, TEMP_CLEANUP_DELAY_MS);
  if (!prepared.ok) return null;

  const cmux = opts.cmuxBin ?? process.env.CMUX_BIN ?? "cmux";
  const result = await processAdapter.run(cmux, prepared.value.argv, {
    timeoutMs: 10_000,
    captureOutput: true,
  });
  if (!result.ok) {
    if (prepared.value.temporaryEnvironment !== null) {
      cleanupTemporaryEnvironment(prepared.value.temporaryEnvironment);
    }
    return null;
  }
  return workspaceRefFromOutput({ stdout: result.stdout, stderr: result.stderr });
}
