/**
 * `ccs hook run <name>` — the named-hook dispatcher (ADR-0017/0029/0034).
 *
 * The roles registry lists which hooks a role wants by NAME (e.g. "session-start", "stop").
 * sync-roles materializes each as `ccs hook run <name>` in settings.json. ccs owns the hook
 * IMPLEMENTATIONS here, so a role picks behavior by name without shipping its own scripts.
 *
 * Every hook reads Claude Code's JSON payload from stdin and ALWAYS exits 0 — a hook must
 * never block a session (fail-open, ADR-0035). Unknown names are a silent no-op (exit 0).
 */
import { registerSessionCommand } from "./register-command.ts";
import { workerStopCommand } from "./worker-stop-command.ts";
import { statuslineCommand } from "./statusline-command.ts";

/** name -> handler. Handlers are self-contained (read stdin, do work, exit-0 semantics). */
const HOOKS: Record<string, () => Promise<number>> = {
  "session-start": registerSessionCommand,
  stop: workerStopCommand,
  statusline: statuslineCommand,
};

export async function hookRunCommand(args: string[]): Promise<number> {
  const name = args[0];
  const handler = name ? HOOKS[name] : undefined;
  if (!handler) {
    // Unknown / missing hook name: fail-open, do nothing, never block the session.
    return 0;
  }
  try {
    return await handler();
  } catch {
    return 0; // any failure is a silent no-op (ADR-0035)
  }
}
