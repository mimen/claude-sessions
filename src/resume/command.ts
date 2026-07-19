import { existsSync, realpathSync } from "node:fs";
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
  /** Single-string form, for cmux --command and for display. */
  readonly shell: string;
}

/**
 * Build the canonical resume invocation for a Session. We always construct
 * `claude --resume <id>` ourselves and run it in the Session's recorded cwd — this is what
 * sidesteps the cwd-scoped picker and the unreliable end-of-session hint (failure modes A/B/D).
 */
export function buildResumeCommand(
  row: SessionRow,
  opts: { fork: boolean; cwd: string; resumeCommand?: string | null },
): ResumeCommand {
  const argv = ["claude", "--resume", row.resumeId];
  if (opts.fork) argv.push("--fork-session");
  // ADR-0015: a loop's resume_command is replayed as the trailing prompt so it comes back
  // RUNNING (`claude --resume <id> '<resume_command>'`). Workers have none → bare resume.
  if (opts.resumeCommand) argv.push(opts.resumeCommand);
  return {
    argv,
    cwd: opts.cwd,
    shell: argv.map(shellQuote).join(" "),
  };
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

  // Last resort when nothing on disk matches: recorded cwd → project root → home.
  if (row.cwd && existsSync(row.cwd)) {
    return { cwd: row.cwd, note: `could not confirm storage dir — resuming in recorded cwd ${row.cwd}` };
  }
  if (existsSync(row.projectRoot)) {
    return { cwd: row.projectRoot, note: `original cwd is gone — resuming in project root ${row.projectRoot}` };
  }
  return { cwd: homedir(), note: "original cwd is gone — resuming in home directory" };
}
