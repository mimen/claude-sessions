/**
 * Role materialization — the PURE reconcile planner (ADR-0022/0034).
 *
 * `~/.claude` is a projection of the roles registry, reconciled by symlink:
 *  - compute the desired links (one per skill/command, into the role's home dir),
 *  - compare against the ccs-owned manifest (what we created last run) + what's on disk,
 *  - create missing/drifted links, prune manifest links no longer desired, and NEVER touch
 *    anything not in the manifest (the user's own files are invisible to prune).
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

/** Desired links for a set of roles: one per skill + per command, into each role's home dir. */
export function desiredLinksForRoles(roles: RoleDef[], claudeDir: string): DesiredLink[] {
  const links: DesiredLink[] = [];
  for (const r of roles) {
    if (!r.homeDir) continue; // no home dir -> nothing to materialize
    for (const skill of r.skills) {
      links.push({
        linkPath: `${claudeDir}/skills/${skill}`,
        target: `${r.homeDir}/skills/${skill}`,
      });
    }
    for (const cmd of r.commands) {
      links.push({
        linkPath: `${claudeDir}/commands/${cmd}`,
        target: `${r.homeDir}/commands/${cmd}`,
      });
    }
  }
  return links;
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
