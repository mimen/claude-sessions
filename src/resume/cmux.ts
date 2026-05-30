import type { ResumeCommand } from "./command.ts";

/**
 * Open the resume in a new, focused cmux workspace named after the Session. Fire-and-forget:
 * cmux is a separate app surface, so this doesn't disturb the running TUI. Returns whether
 * the cmux command succeeded.
 */
export function openInCmux(cmd: ResumeCommand, name: string, binary = "cmux"): boolean {
  try {
    const result = Bun.spawnSync(
      [
        binary,
        "new-workspace",
        "--name",
        name,
        "--cwd",
        cmd.cwd,
        "--command",
        cmd.shell,
        "--focus",
        "true",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
