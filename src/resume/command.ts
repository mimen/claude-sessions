import { existsSync } from "node:fs";
import { homedir } from "node:os";
import type { SessionRow } from "../index/index.ts";

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
export function buildResumeCommand(row: SessionRow, opts: { fork: boolean; cwd: string }): ResumeCommand {
  const argv = ["claude", "--resume", row.sessionId];
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
  if (row.cwd && existsSync(row.cwd)) return { cwd: row.cwd, note: null };
  if (existsSync(row.projectRoot)) {
    return { cwd: row.projectRoot, note: `original cwd is gone — resuming in project root ${row.projectRoot}` };
  }
  return { cwd: homedir(), note: "original cwd is gone — resuming in home directory" };
}
