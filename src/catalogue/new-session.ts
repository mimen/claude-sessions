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
  setSkill,
  setPhase,
  setProject,
  setSystem,
  setResumeId,
  getRoleDef,
  type Kind,
} from "./db.ts";
import { shellQuote } from "../resume/command.ts";

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
  system?: string;
  /** The session's role — the canonical identity axis (ADR-0015). */
  role?: string;
  /** How a loop is re-armed on resume so it comes back running (e.g. `/loop 15m /pr-watch-control`). */
  resumeCommand?: string;
  kind?: Kind;
  phase?: string;
  project?: string;
  key?: string;
  title?: string;
  parent?: string;
  cwd?: string;
  prompt?: string;
  /** Passed through to `claude --permission-mode <mode>` when launching. */
  permissionMode?: string;
  /** Reserve mode: write metadata + print the id, don't launch. */
  printId: boolean;
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
    system: flagValue(args, "--system"),
    // `--role` reads best for the fleet ("this is a pr-agent"); `--skill` is accepted as a
    // synonym since both land in the catalogue `skill` column.
    role: flagValue(args, "--role") ?? flagValue(args, "--skill"),
    resumeCommand: flagValue(args, "--resume-command"),
    kind: kindRaw === "loop" ? "loop" : kindRaw === "session" ? "session" : undefined,
    phase: flagValue(args, "--phase"),
    project: flagValue(args, "--project"),
    key: flagValue(args, "--key"),
    title: flagValue(args, "--title"),
    parent: flagValue(args, "--parent"),
    cwd: flagValue(args, "--cwd"),
    prompt: flagValue(args, "--prompt"),
    permissionMode: flagValue(args, "--permission-mode"),
    printId: args.includes("--print-id"),
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
  if (opts.system) setSystem(db, id, opts.system, now);
  if (opts.role) {
    const role = opts.role.replace(/^\//, "");
    setRole(db, id, role, now); // canonical (ADR-0015)
    setSkill(db, id, role, now); // legacy mirror, kept until every consumer reads `role`
  }
  if (opts.resumeCommand) setResumeCommand(db, id, opts.resumeCommand, now);
  if (opts.kind) setKind(db, id, opts.kind, now);
  if (opts.phase) setPhase(db, id, opts.phase, now);
  if (opts.project) setProject(db, id, opts.project, now);
  if (opts.key) setKey(db, id, opts.key, now);
  if (opts.title) setCustomTitle(db, id, opts.title, now);
  if (opts.parent) setParent(db, id, opts.parent, now);
}

/** Build the `claude` invocation for launch mode. Prompt (if any) is a trailing positional arg. */
function buildLaunchArgv(id: string, opts: NewSessionOpts): string[] {
  const argv = ["claude", "--session-id", id];
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.prompt) argv.push(opts.prompt);
  return argv;
}

export function newSession(args: string[]): number {
  const opts = parseOpts(args);

  ensureDataDir();
  // Registry defaults (ADR-0022): if --role names a defined role, inherit its home_dir as
  // the cwd and its resume_command — so bringing up a core role is just `--role <name>`.
  // Explicit --cwd / --resume-command still win.
  {
    const rdb = openCatalogue(CATALOGUE_PATH);
    try {
      const def = opts.role ? getRoleDef(rdb, opts.role.replace(/^\//, "")) : null;
      if (def) {
        if (!opts.cwd && def.homeDir) opts.cwd = def.homeDir;
        if (!opts.resumeCommand && def.resumeCommand) opts.resumeCommand = def.resumeCommand;
      }
    } finally {
      rdb.close();
    }
  }

  const cwd = opts.cwd ?? process.cwd();

  if (opts.cwd && !existsSync(opts.cwd)) {
    console.error(`ccs: --cwd does not exist: ${opts.cwd}`);
    return 1;
  }

  const id = randomUUID();
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    writeSessionMetadata(db, id, opts, new Date().toISOString());
  } finally {
    db.close();
  }

  // Reserve mode: hand the id back so an external launcher owns the spawn. ONLY the bare id
  // goes to stdout (so `ID=$(ccs new-session … --print-id)` works); notes go to stderr.
  if (opts.printId) {
    const tagged = [
      opts.system && `system=${opts.system}`,
      opts.role && `role=${opts.role}`,
      opts.kind && `kind=${opts.kind}`,
      opts.phase && `phase=${opts.phase}`,
    ]
      .filter(Boolean)
      .join(" ");
    console.error(`ccs: reserved ${id.slice(0, 8)}…${tagged ? ` (${tagged})` : ""} — launch with: claude --session-id ${id}`);
    console.log(id);
    return 0;
  }

  // Launch mode: hand the TTY to an interactive claude bound to the id we just tagged.
  const argv = buildLaunchArgv(id, opts);
  console.error(`ccs: launching ${argv.map(shellQuote).join(" ")}  (cwd: ${cwd})`);
  let result;
  try {
    result = Bun.spawnSync(argv, { cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  } catch (e) {
    console.error(`ccs: failed to launch claude: ${(e as Error).message}`);
    return 127;
  }
  if (!result.success && result.exitCode == null) {
    console.error(`ccs: could not run claude — is it on your PATH?`);
    return 127;
  }
  return result.exitCode ?? 0;
}
