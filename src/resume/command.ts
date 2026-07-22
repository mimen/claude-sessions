import { existsSync, realpathSync, mkdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import type { SessionRow } from "../index/index.ts";
import { locateLaunchDir, storageFolderOf, encodePath } from "./locate.ts";

/** Encoded realpath of a dir, matching how Claude Code derives the storage folder. */
function encodePathRealpath(dir: string): string {
  try {
    return encodePath(realpathSync(dir));
  } catch {
    return encodePath(dir);
  }
}

/** A resume invocation built from Session metadata (never from a printed CLI hint). */
export interface ResumeCommand {
  /** Executable + args to run, e.g. ["claude", "--resume", "<id>"]. */
  readonly argv: string[];
  /** Directory to run it in (the Session's recorded cwd). */
  readonly cwd: string;
  /** Extra env for the spawned process (from the launcher; empty for plain `claude`). */
  readonly env: Readonly<Record<string, string>>;
  /** Single-string form, for cmux --command and for display (env-prefixed when env is set). */
  readonly shell: string;
}

/**
 * Build the canonical resume invocation for a Session. We always construct
 * `<binary> --resume <id>` ourselves and run it in the Session's recorded cwd — this is what
 * sidesteps the cwd-scoped picker and the unreliable end-of-session hint (failure modes A/B/D).
 * `binary` defaults to `claude`; a route through another launcher (claude-gpt, …) swaps argv[0].
 */
export function buildResumeCommand(
  row: SessionRow,
  opts: {
    fork: boolean;
    cwd: string;
    resumeCommand?: string | null;
    binary?: string;
    env?: Readonly<Record<string, string>>;
  },
): ResumeCommand {
  const argv = [opts.binary ?? "claude", "--resume", row.resumeId];
  if (opts.fork) argv.push("--fork-session");
  // ADR-0015: a loop's resume_command is replayed as the trailing prompt so it comes back
  // RUNNING (`claude --resume <id> '<resume_command>'`). Workers have none → bare resume.
  if (opts.resumeCommand) argv.push(opts.resumeCommand);
  const env = opts.env ?? {};
  return {
    argv,
    cwd: opts.cwd,
    env,
    shell: shellWithEnv(argv, env),
  };
}

/** argv → shell string, prefixed with `env K=V …` when the launcher sets env vars. */
export function shellWithEnv(argv: readonly string[], env: Readonly<Record<string, string>>): string {
  const cmd = argv.map(shellQuote).join(" ");
  const pairs = Object.entries(env);
  if (pairs.length === 0) return cmd;
  return `env ${pairs.map(([k, v]) => `${k}=${shellQuote(v)}`).join(" ")} ${cmd}`;
}

/** Minimal POSIX shell quoting for building the cmux --command string. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pick the directory to resume in. The Session's recorded cwd is preferred; if it no longer
 * exists (repo moved/deleted), fall back to the Project root, then the home dir — and report
 * the substitution so the UI can warn instead of silently launching in the wrong place.
 * FAILS CLOSED on filesystem errors per ADR-0066 — a transient I/O error must never look like
 * "absent" and unblock a wrong-dir resume.
 *
 * FUTURE-PROOF ANCHOR RECREATION (ADR-0092, approach A): when nothing on disk maps to the
 * storage folder AND the recorded cwd is simply GONE, we recreate that exact directory. Claude
 * files a transcript under encode(realpath(cwd)); a removed git worktree (worktree-per-issue
 * churn) or a cleaned scratch dir therefore strands the session — no live dir maps back, and
 * `claude --resume` dies with "No conversation found". Recreating the recorded cwd restores the
 * mapping deterministically (we have the EXACT path, not a lossy decode). Verified before use,
 * idempotent, non-destructive (an empty dir where the deleted one was), and self-cleaning when
 * the recreate doesn't actually restore the mapping. Does NOT cover a cwd that still exists but
 * has become a symlink (realpath now differs) — that needs a transcript move, out of this path.
 */
export function resolveResumeCwd(row: SessionRow): { cwd: string; note: string | null } | { error: string } {
  const folder = storageFolderOf(row.path);

  // Best case: the recorded cwd still exists AND its encoded realpath matches the file's
  // storage folder. Then it's authoritative and we avoid the filesystem walk entirely. This
  // also sidesteps lossy-encoding collisions, since we're confirming the real recorded path.
  if (row.cwd && existsSync(row.cwd) && encodePathRealpath(row.cwd) === folder) {
    return { cwd: row.cwd, note: null };
  }

  // Otherwise the recorded cwd has drifted (symlink changed, dir moved). Walk the filesystem
  // to find the dir whose encoded realpath matches the storage folder — the only dir claude
  // will actually find the session from. Bounded so it can never hang the resume path.
  const locatedResult = locateLaunchDir(row.path);
  if (!locatedResult.ok) {
    // FAIL CLOSED: filesystem error during walk — must not proceed with a guess.
    return { error: `Cannot locate resume directory: ${locatedResult.error.message}` };
  }
  const located = locatedResult.value;
  if (located) {
    const notes: string[] = [];
    if (row.cwd && located.dir !== row.cwd) {
      notes.push(`launching from ${located.dir} (recorded cwd ${row.cwd} no longer maps to this session's files)`);
    }
    if (located.ambiguousWith) {
      // Two real dirs encode to the same storage folder (e.g. /a-b and /a/b). Resume works
      // from either, but the working directory may be the wrong repo — surface it.
      notes.push(`ambiguous encoding — also matches ${located.ambiguousWith}`);
    }
    if (located.exhausted) {
      notes.push("filesystem walk exhausted its budget — a further match can't be ruled out");
    }
    return { cwd: located.dir, note: notes.length > 0 ? notes.join(" · ") : null };
  }

  // Future-proof: the recorded cwd is simply GONE (deleted worktree / cleaned scratch). Rebuild
  // it exactly and use it only if that restores the storage-folder mapping. See the header note.
  if (row.cwd && !existsSync(row.cwd)) {
    try {
      mkdirSync(row.cwd, { recursive: true });
      if (encodePathRealpath(row.cwd) === folder) {
        return { cwd: row.cwd, note: `recreated missing anchor dir ${row.cwd} to resume` };
      }
      // Recreated but the realpath still doesn't map (a parent moved or became a symlink): the
      // empty leaf we just made is useless — remove it (best-effort) and fall through.
      try {
        rmdirSync(row.cwd);
      } catch {
        /* leave the harmless empty dir; nothing depends on removing it */
      }
    } catch {
      /* mkdir failed (permissions, a file in the path) — fall through to the last-resort ladder */
    }
  }

  // Last resort when nothing on disk matches: recorded cwd → project root → home.
  if (row.cwd && existsSync(row.cwd)) {
    return { cwd: row.cwd, note: `could not confirm storage dir — resuming in recorded cwd ${row.cwd}` };
  }
  if (existsSync(row.projectRoot)) {
    return { cwd: row.projectRoot, note: `original cwd is gone — resuming in project root ${row.projectRoot}` };
  }
  return { cwd: homedir(), note: "original cwd is gone — resuming in home directory" };
}
