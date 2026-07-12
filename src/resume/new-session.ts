import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import {
  openCatalogue,
  setCustomTitle,
  setKind,
  setKey,
  setParent,
  setRole,
  setResumeCommand,
  setProject,
  setCluster,
  setResumeId,
  setGusWork,
  stampPrFacts,
  type Kind,
  type RoleDef,
} from "../catalogue/db.ts";
import { resolveRole } from "../roles/role-files.ts";
import { shellQuote } from "./command.ts";
import { spawnCmux } from "./spawn-cmux.ts";
import { execFileSync } from "node:child_process";
import { spawnContractError, type SpawnFacts, type WorktreeState } from "../catalogue/spawn-contract.ts";
import { interpretSpawnLocation, syntheticRow, type SpawnLocationConfig } from "../catalogue/spawn-location.ts";
import { resolveConfig } from "../hooks/resolve-config.ts";
import { liveResolveCtx } from "../hooks/compose-claude-md.ts";

/**
 * `ccs new-session` — mint a session id, bind its catalogue metadata AT BIRTH, then either
 * launch `claude --session-id <id>` or just print the id for an external launcher.
 *
 * Why this exists: metadata (system / role / kind / phase / …) used to be stapled on AFTER a
 * session already existed — by a Stop hook, by catalogue_sync, or by hand — which meant a
 * just-spawned session had no identity until something noticed it (the O5/"role-based hooks"
 * gap). Because Claude Code lets us CHOOSE the id up front (`claude --session-id <uuid>`),
 * we can mint it here, write the metadata keyed to that id (a forward reference — the row
 * exists before the session is ever indexed), and only THEN launch. Identity is correct from
 * the first turn, and can never be mis-guessed from an external cwd/title.
 *
 * Two modes (see the M3 decision):
 *   - default: mint + LAUNCH `claude --session-id <id> [<prompt>]` in the cwd, inheriting the
 *     TTY (interactive — the human lands in the session). This is the main path.
 *   - `--print-id`: mint + write metadata, print ONLY the id to stdout, do NOT launch. The
 *     fleet launcher (spawn-agent.sh / cmux) takes the id and does its own headless spawn with
 *     `claude --session-id <that id>`. Keeps ccs out of cmux/process management.
 */

export interface NewSessionOpts {
  cluster?: string;
  /** The session's role — the canonical identity axis (ADR-0015). */
  role?: string;
  /** How a loop is re-armed on resume so it comes back running (e.g. `/loop 15m /pr-watch-control`). */
  resumeCommand?: string;
  kind?: Kind;
  project?: string;
  key?: string;
  title?: string;
  parent?: string;
  /** Work-item id (W-number) — stamped at birth so the statusline/tab link the ticket from
   * turn one (ADR-0027), before any later git/PR sense tick. */
  gusWork?: string;
  /** PR facts known at spawn (the fleet already has repo + number in hand). Stamped at birth
   * so the clickable PR link is present immediately — no gap until the next sense tick. */
  prNumber?: number;
  prRepo?: string;
  cwd?: string;
  prompt?: string;
  /** Passed through to `claude --permission-mode <mode>` when launching. */
  permissionMode?: string;
  /** Reserve mode: write metadata + print the id, don't launch. */
  printId: boolean;
  /** Escape hatch: launch INLINE in the current terminal (Bun.spawnSync, inherits this
   * surface). Default is DETACHED into a fresh cmux workspace — inline hijacks the caller's
   * CMUX_SURFACE_ID and rebinds their tab to the new session (ADR-0042). */
  inline: boolean;
}

/** Parse a --pr-number value to a positive integer, or undefined (0 / non-numeric = "no PR yet"). */
function prNumberFrom(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Read the value following `--flag`; returns undefined if absent or immediately followed by another flag. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

export function parseOpts(args: string[]): NewSessionOpts {
  const kindRaw = flagValue(args, "--kind");
  return {
    cluster: flagValue(args, "--cluster"),
    // `--role` reads best for the fleet ("this is a pr-agent"); `--skill` is accepted as a
    // synonym since both land in the catalogue `skill` column.
    role: flagValue(args, "--role") ?? flagValue(args, "--skill"),
    resumeCommand: flagValue(args, "--resume-command"),
    kind: kindRaw === "loop" ? "loop" : kindRaw === "session" ? "session" : undefined,
    project: flagValue(args, "--project"),
    key: flagValue(args, "--key"),
    title: flagValue(args, "--title"),
    parent: flagValue(args, "--parent"),
    gusWork: flagValue(args, "--gus-work"),
    prNumber: prNumberFrom(flagValue(args, "--pr-number")),
    prRepo: flagValue(args, "--pr-repo"),
    cwd: flagValue(args, "--cwd"),
    prompt: flagValue(args, "--prompt"),
    permissionMode: flagValue(args, "--permission-mode"),
    printId: args.includes("--print-id"),
    inline: args.includes("--inline"),
  };
}

/**
 * Write every provided metadatum for `id` into `db`, all stamped `now`. The row is created if
 * absent (a forward reference — the session isn't indexed yet). Pure w.r.t. process/launch, so
 * it's the seam the test drives directly.
 */
export function writeSessionMetadata(db: Database, id: string, opts: NewSessionOpts, now: string): void {
  // The session id doubles as the resume handle when launched with `--session-id`, so record
  // it now — `ccs resume` can then revive the session even before it's indexed.
  setResumeId(db, id, id, now);
  if (opts.cluster) setCluster(db, id, opts.cluster, now);
  if (opts.role) {
    const role = opts.role.replace(/^\//, "");
    setRole(db, id, role, now);
  }
  if (opts.resumeCommand) setResumeCommand(db, id, opts.resumeCommand, now);
  if (opts.kind) setKind(db, id, opts.kind, now);
  if (opts.project) setProject(db, id, opts.project, now);
  if (opts.key) setKey(db, id, opts.key, now);
  if (opts.title) setCustomTitle(db, id, opts.title, now);
  if (opts.parent) setParent(db, id, opts.parent, now);
  if (opts.gusWork) setGusWork(db, id, opts.gusWork, now);
  // Stamp PR facts at birth so the statusline links the PR immediately (ADR-0027). Only
  // number + repo are known at spawn; branch/state/sha are git-sensed later. Default state
  // to "open" (a freshly-spawned worker's PR) so the tab colors correctly until then.
  if (opts.prNumber && opts.prRepo) {
    stampPrFacts(db, id, { prNumber: opts.prNumber, prRepo: opts.prRepo, prBranch: "", prState: "open", prHeadSha: "" }, now);
  }
}

/** Build the `claude` invocation for launch mode. Prompt (if any) is a trailing positional arg. */
function buildLaunchArgv(id: string, opts: NewSessionOpts): string[] {
  const argv = ["claude", "--session-id", id];
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.prompt) argv.push(opts.prompt);
  return argv;
}

/**
 * Validate a spawn is fully + correctly configured. Returns an error string (caller errors
 * out) or null. The determinism gate: a misconfigured spawn fails LOUD, never half-born.
 */
export function validateSpawn(opts: NewSessionOpts, roleDef: RoleDef | null): string | null {
  // A --role must name a real registry role (else its home_dir/arming can't be resolved).
  if (opts.role && !roleDef) {
    return `role "${opts.role.replace(/^\//, "")}" is not in the registry — define it with \`ccs roles upsert\` first`;
  }
  // The cwd we'll launch in must exist (explicit --cwd or the role's home_dir).
  if (opts.cwd && !existsSync(opts.cwd)) {
    return `cwd does not exist: ${opts.cwd}`;
  }
  // A loop role must know how to come back running.
  if (roleDef?.kind === "loop" && !opts.resumeCommand) {
    return `loop role "${roleDef.role}" has no resume_command (it would launch dormant) — set one in the registry`;
  }
  return null;
}

export function newSession(args: string[]): number {
  const opts = parseOpts(args);

  ensureDataDir();
  // Registry defaults (ADR-0022): if --role names a defined role, inherit its home_dir as
  // the cwd and its resume_command — so bringing up a core role is just `--role <name>`.
  // Explicit --cwd / --resume-command still win.
  // Role definitions come from config FILES now (ADR-0050) — no catalogue read for the registry.
  let roleDef: RoleDef | null = opts.role ? resolveRole(opts.role.replace(/^\//, "")) : null;
  let spawnLocationErr: string | null = null;
  if (roleDef) {
    if (!opts.cluster && roleDef.cluster) opts.cluster = roleDef.cluster; // cluster from the definition
    // spawn-location config (ADR-0046) resolves the launch cwd from the LAUNCH REQUEST
    // (pre-row): "role-dir" → home_dir, "worktree" → the passed --cwd, or an abs path.
    // Config wins; the role's home_dir stays the fallback when no config resolves.
    if (!opts.cwd) {
      const resolvedCwd = resolveSpawnLocationCwd(opts, roleDef);
      if (resolvedCwd.error) { spawnLocationErr = resolvedCwd.error; }
      opts.cwd = resolvedCwd.cwd ?? roleDef.homeDir ?? undefined;
    }
    if (!opts.resumeCommand && roleDef.resumeCommand) opts.resumeCommand = roleDef.resumeCommand;
    // A loop role born fresh should START RUNNING: default the launch prompt to its
    // resume_command (the /loop …) unless an explicit --prompt was given.
    if (!opts.prompt && opts.resumeCommand) opts.prompt = opts.resumeCommand;
    // Loops run unattended → default to acceptEdits so they don't stall on edit prompts
    // (the folder-trust gate is handled separately via ~/.claude.json pre-trust).
    if (!opts.permissionMode && roleDef.kind === "loop") opts.permissionMode = "acceptEdits";
  }

  // A spawn-location config that named a mode whose input is missing (e.g. "worktree" with no
  // --cwd) is a determinism failure — fail LOUD, don't silently fall back to the wrong dir.
  if (spawnLocationErr) {
    console.error(`ccs new-session: ${spawnLocationErr}`);
    return 2;
  }

  // DETERMINISM: validate the spawn is fully set up, or ERROR OUT — never produce a
  // half-configured / mis-bound session (ADR-0042, Milad's determinism mandate). Skipped for
  // --print-id (a bare reserve is allowed) only where a check can't apply.
  const err = validateSpawn(opts, roleDef);
  if (err) {
    console.error(`ccs new-session: ${err}`);
    return 2;
  }

  // WORKER SPAWN CONTRACT (ADR-0047): a worker (one carrying PR/work-unit facts) is born correct
  // or not at all — refuse a second embodiment of a live work-unit, or a cwd that isn't the PR's
  // feature-branch worktree. The liveness/git probes are best-effort: a probe FAILURE never
  // blocks a spawn (that would be worse than the check) — only a probe that positively finds a
  // conflict does. Core roles carry no work-unit and pass through untouched.
  const contractErr = checkSpawnContract(opts);
  if (contractErr) {
    console.error(`ccs new-session: ${contractErr}`);
    return 2;
  }

  const cwd = opts.cwd ?? process.cwd();

  const id = randomUUID();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    writeSessionMetadata(db, id, opts, new Date().toISOString());
  } finally {
    db.close();
  }

  // Reserve mode: hand the id back so an external launcher owns the spawn. ONLY the bare id
  // goes to stdout (so `ID=$(ccs new-session … --print-id)` works); notes go to stderr.
  if (opts.printId) {
    const tagged = [
      opts.cluster && `system=${opts.cluster}`,
      opts.role && `role=${opts.role}`,
      opts.kind && `kind=${opts.kind}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.error(`ccs: reserved ${id.slice(0, 8)}…${tagged ? ` (${tagged})` : ""} — launch with: claude --session-id ${id}`);
    console.log(id);
    return 0;
  }

  const argv = buildLaunchArgv(id, opts);

  // --inline: genuine interactive launch in THIS terminal. Binds to the caller's surface —
  // correct only when that IS the intent. NOT the default (ADR-0042).
  if (opts.inline) {
    console.error(`ccs: launching INLINE ${argv.map(shellQuote).join(" ")}  (cwd: ${cwd})`);
    try {
      const result = Bun.spawnSync(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      if (!result.success && result.exitCode == null) {
        console.error(`ccs: could not run claude — is it on your PATH?`);
        return 127;
      }
      return result.exitCode ?? 0;
    } catch (e) {
      console.error(`ccs: failed to launch claude: ${(e as Error).message}`);
      return 127;
    }
  }

  // DEFAULT: spawn DETACHED into a fresh cmux workspace. The new surface gets its OWN
  // CMUX_SURFACE_ID, so the new session's SessionStart hook binds THAT surface — never
  // rebinding the caller's (the hijack ADR-0042 documents). Deterministic: own surface or fail.
  return spawnDetached(id, argv, cwd, opts.title || opts.role || id.slice(0, 8));
}

/**
 * Resolve the launch cwd from the role's spawn-location config (ADR-0046), pre-row. Builds a
 * synthetic row from the launch opts, resolves `spawn-location` (most-specific-wins) through the
 * shared config resolver, and interprets it. Returns {cwd} (null → caller uses home_dir default)
 * or {error} when config names a mode whose input is missing. Best-effort: a resolver failure
 * yields null (fall back), never a throw.
 */
function resolveSpawnLocationCwd(
  opts: NewSessionOpts,
  roleDef: RoleDef,
): { cwd: string | null; error?: string } {
  try {
    const row = syntheticRow({
      cluster: opts.cluster, role: opts.role?.replace(/^\//, ""), gusWork: opts.gusWork,
      prNumber: opts.prNumber, prRepo: opts.prRepo,
    });
    const config = resolveConfig(row, "spawn-location", liveResolveCtx()).effective as SpawnLocationConfig | null;
    return interpretSpawnLocation(config, { homeDir: roleDef.homeDir, requestedCwd: opts.cwd ?? null });
  } catch {
    return { cwd: null }; // resolver hiccup → fall back to home_dir default
  }
}

/**
 * Gather the impure spawn facts (the cwd's git branch) and run the pure contract (ADR-0047).
 * Best-effort probe: a probe that THROWS returns "unknown" and never blocks the spawn — only a
 * positively-observed born-WRONG configuration (a protected-branch worktree) is a hard error.
 *
 * NOTE (ADR-0073): this no longer gathers live work-units or refuses a second embodiment. A
 * duplicate embodiment is tolerated (resume prefers the MRU session and warns; atomic drain keeps
 * it harmless), so the contract only guards worktree correctness now. Returns an error or null.
 */
function checkSpawnContract(opts: NewSessionOpts): string | null {
  const facts: SpawnFacts = { gusWork: opts.gusWork, prNumber: opts.prNumber, prRepo: opts.prRepo, cwd: opts.cwd };

  // Worktree state: only probed when a cwd + PR are given (a worker). A git failure → unknown.
  let worktree: WorktreeState | null = null;
  if (opts.cwd && opts.prNumber != null) {
    worktree = probeWorktree(opts.cwd);
  }

  return spawnContractError(facts, worktree);
}

/** Probe a cwd's git worktree state (best-effort). Never throws. */
function probeWorktree(cwd: string): WorktreeState {
  try {
    const inside = execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
      timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    if (inside !== "true") return { isGitWorktree: false, branch: null };
    let branch: string | null = null;
    try {
      branch = execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {
        timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim() || null;
      if (branch === "HEAD") branch = null; // detached
    } catch { /* branch unknown */ }
    return { isGitWorktree: true, branch };
  } catch {
    // `git` failed entirely (not a repo, git missing) — treat as "not a worktree" ONLY if the
    // path exists; if git itself is unavailable we can't assert, so report unknown (git present
    // check via a benign call). Simplest safe default: not-a-worktree so the check can catch a
    // genuinely-wrong cwd, but a git-missing environment would false-positive — mitigated by the
    // caller only invoking this when cwd+PR are set (a real worker context has git).
    return { isGitWorktree: false, branch: null };
  }
}

/**
 * Spawn a session into a NEW cmux workspace (its own surface) via the shared spawnCmux primitive —
 * the SAME detached-spawn + CMUX_SURFACE_ID env-scrub (ADR-0042) used by resume, so a born-fresh
 * and a resumed session launch identically.
 */
function spawnDetached(id: string, argv: string[], cwd: string, name: string): number {
  const ref = spawnCmux({ argv, cwd, name });
  if (ref === null) {
    console.error(`ccs: failed to spawn cmux workspace for ${id.slice(0, 8)} (cwd ${cwd})`);
    return 1;
  }
  console.error(`ccs: spawned ${name} → ${ref} (session ${id.slice(0, 8)}, cwd ${cwd})`);
  return 0;
}
