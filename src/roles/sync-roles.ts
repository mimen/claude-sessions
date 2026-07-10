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
import { allRoles, type RoleDef } from "../catalogue/db.ts";
import {
  desiredLinksForRoles,
  planReconcile,
  type LinkState,
  type ReconcilePlan,
} from "./materialize.ts";
import { mergeManagedHooks, MANAGED_TAG, type DesiredHook } from "./hook-materialize.ts";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/** Which Claude Code event a ccs hook name fires on. */
const HOOK_EVENT: Record<string, string> = {
  "session-start": "SessionStart",
  stop: "Stop",
};

/**
 * Desired ccs-managed hook entries from the registry. Each role's `hooks: [name]` becomes a
 * `ccs hook run <name>` command on the mapped event. ccs hooks are GLOBAL + self-filtering
 * (ADR-0018: role-dir hooks don't resolve), so we de-dupe by name across all roles — one
 * managed entry per (event, name), not one per role.
 */
export function desiredHooksForRoles(roles: RoleDef[], ccsBin = "ccs"): DesiredHook[] {
  const names = new Set<string>();
  for (const r of roles) for (const h of r.hooks) names.add(h);
  const out: DesiredHook[] = [];
  for (const name of names) {
    const event = HOOK_EVENT[name];
    if (!event) continue; // unknown hook name -> skip (don't wire a command that no-ops)
    out.push({
      event,
      entry: { matcher: "*", hooks: [{ type: "command", command: `${ccsBin} hook run ${name}`, [MANAGED_TAG]: true }] },
    });
  }
  return out;
}
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
  hooks: number;
  dryRun: boolean;
}

/** Compute the reconcile plan for the current registry (no side effects). */
export function planSyncRoles(db: Database, claudeDir = CLAUDE_DIR): ReconcilePlan {
  const roles = [...allRoles(db).values()];
  const desired = desiredLinksForRoles(roles, claudeDir);
  return planReconcile(desired, readManifest(), probe);
}

/** Apply the reconcile: create/prune symlinks + rewrite the manifest. */
export function syncRoles(
  db: Database,
  opts: { dryRun?: boolean; hooks?: boolean } = {},
): SyncResult {
  const plan = planSyncRoles(db);
  const hookEntries = desiredHooksForRoles([...allRoles(db).values()]);
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
    // Hooks are written into the GLOBAL settings.json (ADR-0018 — role-dir hooks don't
    // resolve; ccs hooks fire everywhere + self-filter by role). Opt-in (opts.hooks) since
    // it touches the user's settings; the managed-merge preserves the user's own hooks.
    if (opts.hooks) writeHookSettings(hookEntries);
  }
  return {
    created: plan.create.length,
    pruned: plan.prune.length,
    collisions: plan.collisions,
    hooks: opts.hooks ? hookEntries.length : 0,
    dryRun: !!opts.dryRun,
  };
}

/** Atomically merge ccs's managed hooks into ~/.claude/settings.json (preserves user hooks). */
function writeHookSettings(desired: DesiredHook[]): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    settings = {}; // missing/unreadable -> start fresh (rare; user usually has one)
  }
  const merged = mergeManagedHooks(settings, desired);
  const tmp = SETTINGS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  // atomic replace so a crash never leaves settings.json half-written
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  renameSync(tmp, SETTINGS_PATH);
}
