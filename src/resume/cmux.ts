import type { ResumeCommand } from "./command.ts";
import { invokeCmuxNewWorkspace } from "./spawn-cmux.ts";

/**
 * Open the resume in a new, focused cmux workspace named after the Session. Fire-and-forget:
 * cmux is a separate app surface, so this doesn't disturb the running TUI. Returns whether
 * the cmux command succeeded. Time-bounded like every cmux call from the TUI — a wedged
 * socket must never block the render thread indefinitely.
 */
export function openInCmux(cmd: ResumeCommand, name: string, binary = "cmux"): boolean {
  return invokeCmuxNewWorkspace(
    {
      argv: cmd.argv,
      cwd: cmd.cwd,
      env: cmd.env,
      unset: cmd.unset,
      name,
      focus: true,
      cmuxBin: binary,
    },
    5000,
  ) !== null;
}
