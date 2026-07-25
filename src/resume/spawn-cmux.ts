import { err, ok, type Result } from "../result.ts";
import { shellQuote } from "./command.ts";

/**
 * The ONE primitive for spawning a `claude` invocation into a fresh, detached cmux workspace.
 * Shared by resume (resumeSessionEntry), TUI resume (openInCmux), and new-session (spawnDetached)
 * so every new-workspace launch is constructed identically.
 *
 * IMPORTANT (cmux 0.64 tracking): the launcher argv runs as a PLAIN command in the new
 * workspace's integrated shell, so cmux's `claude` shim wraps it and its hooks register the
 * session in ~/.cmuxterm/claude-hook-sessions.json (surfaceId → sessionId). Explicit launcher env
 * stays command-scoped: values travel outside `--command` under temporary workspace names, then
 * the short command expands them into the real names for the launcher only. This avoids cmux 1.3.2
 * truncating a long `--command` while ensuring provenance/provider variables do not remain in the
 * interactive shell after the launcher exits. We deliberately DO NOT `exec` or scrub
 * CMUX_SURFACE_ID/CMUX_WORKSPACE_ID: the cmux shim needs those to bind the session to its surface.
 */

const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STAGING_ENV_PREFIX = "CCS_CMUX_STAGED_ENV_";

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
  /** Explicit launcher environment; values remain command-scoped despite cmux's workspace env API. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SpawnCmuxOpts extends CmuxNewWorkspaceOpts {
  readonly cmuxBin?: string;
}

interface StagedEnvironmentEntry {
  readonly key: string;
  readonly value: string;
  readonly stagingKey: string;
}

/**
 * Purely build cmux's `new-workspace` argv. Explicit env values are staged through repeated
 * `--env` pairs because putting their values in `--command` can truncate long launch commands.
 * The real names are assigned only inside `env`; every staging name is removed from the child and
 * then unset from the interactive shell after the launcher exits. Invalid shell environment names
 * fail closed before cmux is invoked.
 */
export function buildCmuxNewWorkspaceArgv(opts: CmuxNewWorkspaceOpts): Result<string[]> {
  const environment = Object.entries(opts.env ?? {});
  for (const [key] of environment) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      return err(new Error(`invalid launcher environment key: ${JSON.stringify(key)}`));
    }
  }

  const realKeys = new Set(environment.map(([key]) => key));
  let nextStagingIndex = 0;
  const staged: StagedEnvironmentEntry[] = environment.map(([key, value]) => {
    while (realKeys.has(`${STAGING_ENV_PREFIX}${nextStagingIndex}`)) nextStagingIndex++;
    const stagingKey = `${STAGING_ENV_PREFIX}${nextStagingIndex}`;
    nextStagingIndex++;
    return { key, value, stagingKey };
  });

  const launcher = opts.argv.map(shellQuote).join(" ");
  let command = launcher;
  if (staged.length > 0) {
    const unsetFromChild = staged.flatMap((entry) => ["-u", entry.stagingKey]);
    const realAssignments = staged.map((entry) => `${entry.key}="$${entry.stagingKey}"`);
    const cleanup = staged.map((entry) => entry.stagingKey).join(" ");
    command = `env ${[...unsetFromChild, ...realAssignments].join(" ")} ${launcher}; unset ${cleanup}`;
  }

  const argv = ["new-workspace", "--cwd", opts.cwd, "--name", opts.name, "--command", command];
  for (const entry of staged) argv.push("--env", `${entry.stagingKey}=${entry.value}`);
  if (opts.focus) argv.push("--focus", "true");
  return ok(argv);
}

/** The new workspace ref (e.g. "workspace:60") on success, or null on any failure. */
export function spawnCmux(opts: SpawnCmuxOpts): string | null {
  const built = buildCmuxNewWorkspaceArgv(opts);
  if (!built.ok) return null;
  const cmux = opts.cmuxBin ?? process.env.CMUX_BIN ?? "cmux";
  try {
    const r = Bun.spawnSync([cmux, ...built.value], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    if (!r.success) return null;

    // Parse the workspace ref: JSON-first (look for a ref or id field), then regex fallback
    // to preserve current behavior if cmux returns plain text. Current 0.64.17 prints text,
    // so the regex is the live path; the JSON parse future-proofs for structured output.
    const stdout = r.stdout?.toString() ?? "";
    const stderr = r.stderr?.toString() ?? "";

    // Try JSON parse from stdout
    try {
      const json = JSON.parse(stdout);
      if (json?.ref) return json.ref;
      if (json?.id) return json.id;
    } catch {
      // Not JSON, fall through to regex
    }

    // Regex fallback on both stdout + stderr (current behavior)
    const combined = stdout + stderr;
    const ref = combined.match(/workspace:[0-9]+/)?.[0] ?? null;
    return ref;
  } catch {
    return null;
  }
}
