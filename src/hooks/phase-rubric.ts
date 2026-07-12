import type { CatalogueRow } from "../catalogue/db.ts";

/**
 * The pr-agent phase self-evaluation rubric, injected at turn boundaries (start via claude-md, end
 * via the Stop hook) so a worker re-evaluates and self-reports its ACTIVITY every turn. See
 * roles/pr-agent/docs/phase-state-machine.md. Phase = STAGE × ACTIVITY: the engine latches the
 * stage (forward-only), the worker owns the activity (working / needs-you) — `fixing` is sensed.
 *
 * Only pr-agent workers get this — a role with a PR/work-unit. Other roles have no phase rubric.
 */

/** Is this a worker that should self-evaluate an activity (a pr-agent)? */
export function isPhaseWorker(row: CatalogueRow | null): boolean {
  return !!row && row.role === "pr-agent";
}

/** The rubric block injected at a turn boundary — the current stage · activity + how to self-set. */
export function phaseRubric(row: CatalogueRow): string {
  const stage = row.stage ?? "building";
  const activity = row.activity ?? "dormant";
  return [
    "## phase self-check (report honestly — this drives your tab)",
    `Stage **${stage}** · **${activity}**. The STAGE advances mechanically (build done → your`,
    "review → in review → approved → merged); you don't move it except by declaring the build ready.",
    "A stage at rest is DORMANT (the bare stage — building it, or awaiting review/merge). The only",
    "thing YOU report is when you get STUCK:",
    "",
    "- `ccs activity . needs-you` — you're stuck on an ambiguous fork and need Milad's DECISION to",
    "  proceed (not a review). Set it the moment you can't proceed without him.",
    "- `ccs activity . --off` — you're unstuck; back to dormant (progressing/waiting in your stage).",
    "",
    "(`fixing` is set for you when CI is red / there's a conflict / changes were requested — and",
    "cleared for you when that resolves. Don't set it by hand.)",
    "When you believe the build is DONE and ready for Milad's review, run `ccs ready .`.",
    "You can also post a one-line freeform status: `ccs status . \"<what you're doing>\"`.",
  ].join("\n");
}
