import type { ResumeCommand } from "./command.ts";

/**
 * Hand the terminal to an interactive `claude` in the Session's cwd. MUST be called after the
 * Ink app has unmounted (terminal restored), so Claude owns the TTY. Blocks until Claude
 * exits; returns its exit code. This is the inline resume path.
 */
export function handoffInline(cmd: ResumeCommand): number {
  const result = Bun.spawnSync(cmd.argv, {
    cwd: cmd.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode ?? 0;
}
