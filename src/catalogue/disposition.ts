import type { Lifecycle } from "./db.ts";

/**
 * Disposition is NOT stored — it's computed from two orthogonal axes so it can never rot:
 *   lifecycle (stored intent: archived > completed > parked > idle)  ×  open (derived live)
 * This module is pure (no I/O), so it's trivially testable and shared by TUI + CLI.
 */

export interface Disposition {
  lifecycle: Lifecycle;
  open: boolean;
  /** Short display label combining both axes. */
  label: string;
  /** Open + a terminal-ish lifecycle (parked/completed): surface a "resolve?" nudge. */
  nudge: boolean;
  /** Hidden from default views unless the user opts to show archived. */
  hidden: boolean;
}

export function describe(lifecycle: Lifecycle, open: boolean): Disposition {
  const base: Omit<Disposition, "label"> = {
    lifecycle,
    open,
    nudge: open && (lifecycle === "parked" || lifecycle === "completed"),
    hidden: lifecycle === "archived",
  };
  let label: string;
  if (lifecycle === "idle") label = open ? "active" : "idle";
  else label = open ? `${lifecycle}·open` : lifecycle;
  return { ...base, label };
}
