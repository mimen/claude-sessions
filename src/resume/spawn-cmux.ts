import { shellQuote } from "./command.ts";

/**
 * The ONE primitive for spawning a `claude` invocation into a fresh, detached cmux workspace.
 * Shared by resume (resumeSessionEntry) and new-session (spawnDetached) so both born-fresh and
 * resumed sessions launch identically.
 *
 * IMPORTANT (cmux 0.64 tracking): the command runs as a PLAIN command in the new workspace's
 * integrated shell, so cmux's `claude` shim wraps it and its hooks register the session in
 * ~/.cmuxterm/claude-hook-sessions.json (surfaceId → sessionId). That store is how ccs knows a
 * session is live. We deliberately DO NOT `exec` or scrub CMUX_SURFACE_ID/CMUX_WORKSPACE_ID:
 * a live experiment (2026-07-11) proved that scrub PREVENTED cmux from binding the session to its
 * surface (the shim needs those vars), leaving the session untracked — the "everything shows
 * closed" bug. cmux assigns the new workspace its own fresh surface id, so there's nothing to
 * hijack (and we hold to one-session-per-workspace, so no sibling to clobber). Plain command it is.
 */

export interface SpawnCmuxOpts {
  /** argv to run, e.g. ["claude", "--resume", "<id>", "<loop-cmd>"]. */
  readonly argv: string[];
  /** cwd for the new workspace (the resolved anchor dir). */
  readonly cwd: string;
  /** cmux workspace name/title. */
  readonly name: string;
  /** Focus the new workspace after creating it (TUI/interactive resume wants this; a batch
   * cluster resume of many panes generally does not). Default false. */
  readonly focus?: boolean;
  readonly cmuxBin?: string;
}

/** The new workspace ref (e.g. "workspace:60") on success, or null on any failure. */
export function spawnCmux(opts: SpawnCmuxOpts): string | null {
  const cmux = opts.cmuxBin ?? process.env.CMUX_BIN ?? "cmux";
  // Plain command — no `exec`, no env-scrub — so the workspace's shell resolves cmux's claude
  // shim and the session registers in the hook store (see the header note). cmux gives the new
  // workspace its own surface id.
  const command = opts.argv.map(shellQuote).join(" ");
  const args = ["new-workspace", "--cwd", opts.cwd, "--name", opts.name, "--command", command];
  if (opts.focus) args.push("--focus", "true");
  try {
    const r = Bun.spawnSync([cmux, ...args], {
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
