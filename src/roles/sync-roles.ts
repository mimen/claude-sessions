/**
 * `ccs sync-roles` — apply the materialization reconcile (ADR-0022/0034, revised by ADR-0074).
 *
 * ADR-0074: per-role skills + commands are NO LONGER materialized into ~/.claude (they're
 * discovered project-level from the role's cwd/.claude/). Only GLOBAL hooks + statusline are
 * materialized into ~/.claude/settings.json. This sync PRUNES any existing ccs-managed skill/
 * command symlinks (cleanup of the old model), but creates NONE (desiredLinksForRoles → []).
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
import { allRolesFromFiles } from "./role-files.ts";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";
import {
  desiredLinksForRoles,
  planReconcile,
  type LinkState,
  type ReconcilePlan,
} from "./materialize.ts";
import {
  mergeManagedHooks,
  mergeManagedStatusline,
  MANAGED_TAG,
  type DesiredHook,
  type StatusLineSetting,
} from "./hook-materialize.ts";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

/**
 * The GLOBAL ccs hooks (ADR-0048 model A): `session-start` + `stop` fire for EVERY session and
 * self-filter by the session's row (ADR-0018) — so they are wired ONCE, unconditionally, not
 * enrolled per-role. Listing them per-role was always redundant (they're global), and it
 * conflated the materialization list with the layered-config types derived from `.ccs-hooks/`.
 * This is the whole set; adding a global hook = adding an entry here + a handler.
 */
const GLOBAL_HOOKS: ReadonlyArray<{ name: string; event: string }> = [
  { name: "session-start", event: "SessionStart" },
  { name: "stop", event: "Stop" },
];

/** The ccs-managed statusLine setting, materialized unconditionally: the `ccs statusline`
 * command self-filters (a non-worker session prints a plain cwd default), so there's no per-role
 * enrollment to compute — a role that wants a rich line ships a `.ccs-hooks/statusline.json`,
 * which the resolver reads at render time (ADR-0027/0048). */
export function desiredStatusline(ccsBin = "ccs"): StatusLineSetting {
  return { type: "command", command: `${ccsBin} statusline` };
}

/**
 * The GLOBAL ccs-managed hook entries — one per global hook, unconditional. They're global +
 * self-filtering (ADR-0018: role-dir hooks don't resolve), so materialization doesn't depend on
 * which roles exist. No per-role `hooks` list is consulted (ADR-0048 model A).
 */
export function desiredHooks(ccsBin = "ccs"): DesiredHook[] {
  return GLOBAL_HOOKS.map(({ name, event }) => ({
    event,
    entry: { matcher: "*", hooks: [{ type: "command", command: `${ccsBin} hook run ${name}`, [MANAGED_TAG]: true }] },
  }));
}
// The manifest is RUNTIME state (what ccs materialized, for safe pruning) — under ~/.ccs,
// honoring $CCS_ROOT (ADR-0041/0049), not a raw homedir join.
const manifestPath = () => join(ccsRuntimeRoot(), "materialization-manifest.json");

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
    const v = JSON.parse(readFileSync(manifestPath(), "utf8"));
    return Array.isArray(v?.links) ? v.links : [];
  } catch {
    return [];
  }
}

function writeManifest(links: string[]): void {
  mkdirSync(dirname(manifestPath()), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify({ links: links.sort() }, null, 2) + "\n");
}

export interface SyncResult {
  created: number;
  pruned: number;
  collisions: string[];
  hooks: number;
  /** true iff a role wants the ccs statusline but the user has their own (we never clobber it). */
  statuslineBlocked: boolean;
  dryRun: boolean;
}

/** Compute the reconcile plan from the config PACKAGE FILES (ADR-0048/0050), no side effects. */
export function planSyncRoles(claudeDir = CLAUDE_DIR): ReconcilePlan {
  const roles = [...allRolesFromFiles().values()];
  const desired = desiredLinksForRoles(roles, claudeDir);
  return planReconcile(desired, readManifest(), probe);
}

/** Apply the reconcile: create/prune symlinks + rewrite the manifest. Roles come from files
 * (ADR-0050); the GLOBAL hooks + statusline are materialized unconditionally (ADR-0048 model A).
 * ADR-0074: skills/commands are no longer created (desiredLinksForRoles → []), but we prune any
 * EXISTING ccs-managed skill/command symlinks from the prior model (one-time cleanup). */
export function syncRoles(opts: { dryRun?: boolean; hooks?: boolean } = {}): SyncResult {
  const plan = planSyncRoles();
  const hookEntries = desiredHooks();
  const statusline = desiredStatusline();
  let statuslineBlocked = false;
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
    // Prune manifest entries (will include the legacy skill/command symlinks on this run —
    // ADR-0074 one-time cleanup, since desiredLinksForRoles now returns empty).
    for (const stale of plan.prune) {
      try {
        rmSync(stale);
      } catch {
        /* already gone — fine */
      }
    }
    writeManifest(plan.nextManifest);
    // Hooks + statusLine are written into the GLOBAL settings.json (ADR-0018/0027 — role-dir
    // settings don't resolve; ccs instrumentation fires everywhere + self-filters by role).
    // Opt-in (opts.hooks) since it touches the user's settings; the managed-merges preserve
    // the user's own hooks + statusLine.
    if (opts.hooks) statuslineBlocked = writeHookSettings(hookEntries, statusline);
  }
  return {
    created: plan.create.length,
    pruned: plan.prune.length,
    collisions: plan.collisions,
    hooks: opts.hooks ? hookEntries.length : 0,
    statuslineBlocked,
    dryRun: !!opts.dryRun,
  };
}

/** Atomically merge ccs's managed hooks + statusLine into ~/.claude/settings.json (preserves
 * the user's own hooks + statusLine). Returns true iff a user statusLine blocked ours. */
function writeHookSettings(desired: DesiredHook[], statusline: StatusLineSetting | null): boolean {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    settings = {}; // missing/unreadable -> start fresh (rare; user usually has one)
  }
  const withHooks = mergeManagedHooks(settings, desired);
  const { settings: merged, collision } = mergeManagedStatusline(withHooks, statusline);
  const tmp = SETTINGS_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n");
  // atomic replace so a crash never leaves settings.json half-written
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  renameSync(tmp, SETTINGS_PATH);
  return collision;
}
