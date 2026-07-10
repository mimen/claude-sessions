/**
 * `ccs sync-roles` — apply the materialization reconcile (ADR-0022/0034).
 *
 * Thin I/O layer over the pure planner in materialize.ts: probe disk, read/write the ccs
 * manifest, create/prune symlinks. All the risky decisions live in the tested planner; this
 * just executes them and reports.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import { allRoles } from "../catalogue/db.ts";
import {
  desiredLinksForRoles,
  planReconcile,
  type LinkState,
  type ReconcilePlan,
} from "./materialize.ts";

const CLAUDE_DIR = join(homedir(), ".claude");
const MANIFEST_PATH = join(homedir(), ".ccs", "materialization-manifest.json");

/** Probe what's currently at a link path (absent / our-ish symlink / a real file). */
function probe(linkPath: string): LinkState {
  let stat;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return { kind: "absent" };
  }
  if (stat.isSymbolicLink()) {
    try {
      return { kind: "symlink", target: readlinkSync(linkPath) };
    } catch {
      return { kind: "symlink", target: "" };
    }
  }
  return { kind: "file" }; // a real file/dir — a collision, never clobbered
}

function readManifest(): string[] {
  try {
    const v = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    return Array.isArray(v?.links) ? v.links : [];
  } catch {
    return [];
  }
}

function writeManifest(links: string[]): void {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify({ links: links.sort() }, null, 2) + "\n");
}

export interface SyncResult {
  created: number;
  pruned: number;
  collisions: string[];
  dryRun: boolean;
}

/** Compute the reconcile plan for the current registry (no side effects). */
export function planSyncRoles(db: Database, claudeDir = CLAUDE_DIR): ReconcilePlan {
  const roles = [...allRoles(db).values()];
  const desired = desiredLinksForRoles(roles, claudeDir);
  return planReconcile(desired, readManifest(), probe);
}

/** Apply the reconcile: create/prune symlinks + rewrite the manifest. */
export function syncRoles(db: Database, opts: { dryRun?: boolean } = {}): SyncResult {
  const plan = planSyncRoles(db);
  if (!opts.dryRun) {
    for (const link of plan.create) {
      mkdirSync(dirname(link.linkPath), { recursive: true });
      if (existsSync(link.linkPath) || probe(link.linkPath).kind === "symlink") {
        try {
          rmSync(link.linkPath); // clear a drifted symlink before recreating
        } catch {
          /* ignore */
        }
      }
      try {
        symlinkSync(link.target, link.linkPath);
      } catch {
        /* leave for the next run; never throw mid-reconcile */
      }
    }
    for (const stale of plan.prune) {
      try {
        rmSync(stale);
      } catch {
        /* already gone — fine */
      }
    }
    writeManifest(plan.nextManifest);
  }
  return {
    created: plan.create.length,
    pruned: plan.prune.length,
    collisions: plan.collisions,
    dryRun: !!opts.dryRun,
  };
}
