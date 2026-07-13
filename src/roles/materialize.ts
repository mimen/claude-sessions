/**
 * Role materialization — the PURE reconcile planner (ADR-0022/0034, revised by ADR-0074).
 *
 * ADR-0074: per-role skills + commands are NO LONGER materialized into ~/.claude — they're
 * discovered PROJECT-LEVEL from the role's cwd/.claude/ by Claude Code. Only GLOBAL hooks +
 * statusline remain user-level (they fire everywhere, self-filter by role, and MUST be in
 * ~/.claude/settings.json to be seen by all sessions).
 *
 * `desiredLinksForRoles` is retained for test compatibility but returns empty — role skills/
 * commands are no longer symlinked. The reconcile planner (`planReconcile`) is unchanged and
 * used to prune any EXISTING ccs-managed skill/command symlinks on this sync run (cleanup).
 *
 * This module has no I/O — the caller supplies an `onDisk` probe and applies the plan. That
 * keeps the reconcile logic (the risky part) fully testable.
 */
import type { RoleDef } from "../catalogue/db.ts";

export interface DesiredLink {
  linkPath: string;
  target: string;
}

/** What ccs finds at a candidate link path on disk. */
export type LinkState =
  | { kind: "absent" }
  | { kind: "symlink"; target: string }
  | { kind: "file" }; // a real file/dir (not a symlink) — a collision if we wanted to link here

export interface ReconcilePlan {
  /** links to (re)create */
  create: DesiredLink[];
  /** manifest link paths to remove (ours, no longer desired) */
  prune: string[];
  /** desired link paths blocked by a non-ccs real file — skipped + reported, never clobbered */
  collisions: string[];
  /** the manifest to persist after applying (exactly the desired link paths) */
  nextManifest: string[];
}

/**
 * ADR-0074: per-role skills + commands are NO LONGER materialized into ~/.claude — they're
 * discovered project-level from the role's cwd/.claude/. This function now returns EMPTY
 * (retained for test compatibility + to drive the prune of any existing ccs-managed symlinks
 * from prior runs). Only GLOBAL hooks + statusline remain materialized into ~/.claude.
 */
export function desiredLinksForRoles(roles: RoleDef[], claudeDir: string): DesiredLink[] {
  return []; // ADR-0074: no per-role skills/commands in ~/.claude — project-level discovery
}

/**
 * Reconcile the desired links against the prior manifest + on-disk state.
 * @param desired  the links we want to exist
 * @param manifest the link paths ccs created on prior runs (the ONLY paths prune may remove)
 * @param onDisk   probe: what is currently at a given link path
 */
export function planReconcile(
  desired: DesiredLink[],
  manifest: string[],
  onDisk: (linkPath: string) => LinkState,
): ReconcilePlan {
  const desiredByPath = new Map(desired.map((l) => [l.linkPath, l]));
  const create: DesiredLink[] = [];
  const collisions: string[] = [];

  for (const link of desired) {
    const state = onDisk(link.linkPath);
    if (state.kind === "symlink" && state.target === link.target) {
      continue; // already correct — idempotent no-op
    }
    if (state.kind === "file") {
      collisions.push(link.linkPath); // a real non-ccs file sits here — refuse, never clobber
      continue;
    }
    // absent, or a symlink pointing at the wrong target -> (re)create
    create.push(link);
  }

  // prune: manifest entries we no longer want. ONLY manifest paths are eligible, so a
  // user's hand-made link (never in the manifest) is never removed.
  const prune = manifest.filter((p) => !desiredByPath.has(p));

  return {
    create,
    prune,
    collisions,
    nextManifest: desired.map((l) => l.linkPath),
  };
}
