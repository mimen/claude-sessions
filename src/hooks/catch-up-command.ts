/**
 * `ccs catch-up [<session-id>|.]` — surface the cluster CHANGELOG entries this identity hasn't seen
 * yet, then advance its last-seen stamp (ADR-0058).
 *
 * This is the PER-TICK companion to the `catch-up` start action. The start action fires on
 * SessionStart, which covers spawn + resume — but a long-lived loop (control/concierge/scout)
 * re-arms with `/loop` inside the SAME session, so it never re-hits SessionStart on a normal tick.
 * Its command block `!`-injects `ccs catch-up` each tick so a changelog bumped mid-session still
 * reaches it. Both paths call the same `catchUp` core (stamp compare → surface delta → advance),
 * so the efficacy of the retired engine `changelog.py` is preserved: read every tick, idempotent,
 * and the `anyRestart` signal is exposed via the exit code for control to act on.
 *
 * Exit codes: 0 = nothing new OR surfaced-no-restart; 2 = surfaced AND an entry needs a restart
 * (control keys on this to restart affected workers). 1 = not resolvable to a session.
 */
import { openCatalogue, getRow } from "../catalogue/db.ts";
import { CATALOGUE_PATH } from "../paths.ts";
import { existsSync } from "node:fs";
import { catchUp } from "../cluster/changelog.ts";
import { responsibilityOf } from "./start-actions.ts";

function resolveSessionId(arg: string | undefined): string | null {
  if (!arg || arg === "." || arg === "self") return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  return arg;
}

export function catchUpCommand(args: string[]): number {
  const id = resolveSessionId(args.find((a) => !a.startsWith("--")));
  if (!id) {
    console.error("ccs: not inside a session and no id given. Usage: ccs catch-up [<session-id>|.]");
    return 1;
  }
  if (!existsSync(CATALOGUE_PATH())) return 0; // no catalogue → nothing to catch up on (fail-soft)
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const row = getRow(db, id);
    if (!row || !row.cluster) return 0; // no row / no cluster → nothing to catch up on
    const res = catchUp(row.cluster, responsibilityOf(row));
    if (!res.context) return 0; // up to date (or no CHANGELOG) → silent, matches the start action
    console.log(res.context);
    return res.anyRestart ? 2 : 0;
  } finally {
    db.close();
  }
}
