import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { SessionRow } from "../index/index.ts";
import { locateLaunchDir, storageFolderOf, encodesTo } from "./locate.ts";

/** A resume invocation built from Session metadata (never from a printed CLI hint). */
export interface ResumeCommand {
  /** Executable + args to run, e.g. ["claude", "--resume", "<id>"]. */
  readonly argv: string[];
  /** Directory to run it in (the Session's recorded cwd). */
  readonly cwd: string;
  /** Single-string form, for cmux --command and for display. */
  readonly shell: string;
  /** cwd-resolution warning to show the user (ambiguity/drift) — must survive TUI teardown. */
  readonly note?: string | null;
}

/**
 * Build the canonical resume invocation for a Session. We always construct
 * `claude --resume <id>` ourselves and run it in the Session's recorded cwd — this is what
 * sidesteps the cwd-scoped picker and the unreliable end-of-session hint (failure modes A/B/D).
 */
export function buildResumeCommand(row: SessionRow, opts: { fork: boolean; cwd: string }): ResumeCommand {
  const argv = ["claude", "--resume", row.resumeId];
  if (opts.fork) argv.push("--fork-session");
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
 */
export function resolveResumeCwd(row: SessionRow): { cwd: string; note: string | null } {
  const folder = storageFolderOf(row.path);

  // Best case: the recorded cwd still exists AND its encoded realpath matches the file's
  // storage folder. Then it's authoritative and we avoid the filesystem walk entirely. This
  // also sidesteps lossy-encoding collisions, since we're confirming the real recorded path.
  if (row.cwd && existsSync(row.cwd) && encodesTo(row.cwd, folder)) {
    return { cwd: row.cwd, note: null };
  }

  // Otherwise the recorded cwd has drifted (symlink changed, dir moved). Walk the filesystem
  // to find the dir whose encoded realpath matches the storage folder — the only dir claude
  // will actually find the session from. Bounded so it can never hang the resume path.
  const located = locateLaunchDir(row.path);
  if (located) {
    const notes: string[] = [];
    // A second verified match means the lossy encoding is genuinely ambiguous (/a-b vs /a/b):
    // resume still works from either, but say so — the WORKING DIRECTORY might be the wrong repo.
    if (located.ambiguousWith) {
      notes.push(`encoding is ambiguous — ${located.ambiguousWith} also matches; verify the directory`);
    } else if (located.exhausted) {
      // The bounded search gave up with work left: one match, but ambiguity wasn't ruled out.
      notes.push("bounded search — another same-encoding dir may exist; verify the directory");
    }
    if (row.cwd && located.dir !== row.cwd) {
      notes.push(`launching from ${located.dir} (recorded cwd ${row.cwd} no longer maps to this session's files)`);
    }
    return { cwd: located.dir, note: notes.length ? notes.join(" · ") : null };
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
