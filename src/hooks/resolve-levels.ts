import type { CatalogueRow } from "../catalogue/db.ts";
import { join } from "node:path";
import { workUnitPath } from "../catalogue/spawn-contract.ts";

/**
 * Layered hook resolution — the PURE level resolver (ADR-0043).
 *
 * Given a session's catalogue row, produce the ordered list of identity LEVELS
 * (user → cluster → role → epic → work-unit → identity) and, for each, the directory
 * whose `.ccs-hooks/<type>.{md,json}` file MAY contribute config for a hook type.
 *
 * This is the deterministic core of ADR-0043/0045: resolution is a pure function of the row
 * (never cwd, never the environment), so two sessions with the same identity resolve identically.
 * All I/O (reading the files, applying the per-type merge) lives in the caller — this only
 * decides WHICH directories, in WHAT order.
 *
 * NB `spawn-location` is the one hook that does NOT use this resolver: it fires at new-session,
 * before a row exists, and resolves from the launch request instead (ADR-0043/0046).
 */

/** The six identity levels, broad → specific. This order is also the merge order (ADR-0044). */
export type Level = "user" | "cluster" | "role" | "epic" | "work-unit" | "identity";

/** One resolved level: its name and the base dir under which its `.ccs-hooks/` lives. */
export interface ResolvedLevel {
  level: Level;
  /** Absolute base dir; the config file is `<dir>/.ccs-hooks/<type>.{md,json}`. */
  dir: string;
}

/** What the resolver needs from the world — kept as inputs so the function stays pure. */
export interface ResolveCtx {
  /** Config root for definitional levels (user/cluster/role/epic) — `~/.ccs-config` (git). */
  configRoot: string;
  /** Runtime root for the identity level — `~/.ccs` (never git). */
  runtimeRoot: string;
  /** Resolve a role name to its registered home_dir (the role level's base dir), or null. */
  roleHomeDir: (role: string) => string | null;
}

const SAFE = /[^a-zA-Z0-9_.-]+/g;
/** Sanitize one path component (mirrors identity-path.seg): no separators/traversal. */
function seg(s: string): string {
  const cleaned = s.replace(/[/\\]/g, "-").replace(/\.\.+/g, "-").replace(SAFE, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

/** The filesystem-safe work-unit key for a row's hook-level dir — the canonical path form
 * (spawn-contract.workUnitPath), shared with the identity/inbox dir so they never diverge. */
export function workUnitOf(row: CatalogueRow): string | null {
  return workUnitPath(row);
}

/**
 * Resolve the ordered levels for a row. A level is INCLUDED only when the row carries the axis
 * that defines it (no cluster → no cluster level, etc.); user + identity always resolve. The
 * caller then probes each level's `.ccs-hooks/<type>` file — absent levels simply contribute
 * nothing (ADR-0045: absent = absent, no search).
 */
export function resolveLevels(row: CatalogueRow, ctx: ResolveCtx): ResolvedLevel[] {
  const out: ResolvedLevel[] = [];

  // user / global — the floor, always present.
  out.push({ level: "user", dir: ctx.configRoot });

  const cluster = row.system;
  if (cluster) {
    out.push({ level: "cluster", dir: join(ctx.configRoot, "clusters", seg(cluster)) });
  }

  if (row.role) {
    const home = ctx.roleHomeDir(row.role);
    // Only a registered role contributes a role level (its home_dir is the base). An unknown
    // role has no role-level config — it just doesn't contribute (fail-open, not fail-loud).
    if (home) out.push({ level: "role", dir: home });
  }

  // epic — only meaningful inside a cluster (its dir nests under the cluster).
  if (cluster && row.epicId) {
    out.push({ level: "epic", dir: join(ctx.configRoot, "clusters", seg(cluster), "epics", seg(row.epicId)) });
  }

  // work-unit — the PR/ticket dir under the cluster (fleet only).
  const unit = workUnitOf(row);
  if (cluster && unit) {
    out.push({ level: "work-unit", dir: join(ctx.configRoot, "clusters", seg(cluster), "work-units", unit) });
  }

  // identity — the runtime dir for this responsibility (never git, ADR-0041). Mirrors
  // identity-path.identityDir so the hook config sits alongside the identity's inbox + state.
  out.push({ level: "identity", dir: identityBaseDir(row, ctx.runtimeRoot) });

  return out;
}

/** The identity level's base dir (runtime). Mirrors inbox/identity-path.identityDir's layout. */
function identityBaseDir(row: CatalogueRow, runtimeRoot: string): string {
  const role = seg(row.role ?? "unknown");
  let dir = row.system
    ? join(runtimeRoot, "clusters", seg(row.system), "identities", role)
    : join(runtimeRoot, "roles", role, "identities", role);
  if (row.epicId) dir = join(dir, seg(row.epicId));
  const unit = workUnitOf(row);
  if (unit) dir = join(dir, unit);
  return dir;
}

/** The fixed sub-path a level contributes for a hook type (ADR-0045: fixed, no search). */
export function hookFileBase(levelDir: string, type: string): string {
  return join(levelDir, ".ccs-hooks", seg(type));
}
