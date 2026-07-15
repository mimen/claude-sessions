import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { RoleDef, Kind, WorkUnitAnchorType, StageSchema } from "../catalogue/db.ts";

/**
 * File-backed role definitions (ADR-0048/0050/0074): a role is a directory in a cluster package;
 * its definition is READ FROM FILES, not a sqlite table. This is the source of truth.
 *
 * A role dir holds only `role.toml` carrying the non-derivable metadata — `kind` +
 * `resume_command`. Everything else is DERIVED:
 *   - role name   = the directory name
 *   - cluster     = the parent path (clusters/<cluster>/roles/<role>) or null (standalone)
 *   - home_dir    = the directory itself (computed at load — NEVER a stored absolute path)
 *   - skills[]    = names present under <role>/.claude/skills/ (ADR-0074), fallback <role>/skills/
 *   - commands[]  = base-names of *.md under <role>/.claude/commands/ (ADR-0074), fallback <role>/commands/
 *   - hooks[]     = hook-type names present under <role>/.ccs-hooks/ (file-presence, ADR-0043)
 *
 * Pure w.r.t. logic; the only I/O is reading the config tree. No cache — role reads aren't hot
 * (spawn + SessionStart), and files-as-truth is only honest with no second copy to drift.
 */

/** The config root (definitions). Honors $CCS_CONFIG_ROOT, else ~/.ccs-config (ADR-0041). */
export function ccsConfigRoot(): string {
  return process.env.CCS_CONFIG_ROOT ?? join(process.env.HOME ?? "", ".ccs-config");
}

interface RoleToml {
  kind?: string;
  resume_command?: string;
  /** ADR-0069 anchor type: pr | gus | freeform | none. Subsumes the interim ADR-0062 `topology`. */
  work_unit?: string;
  /** ADR-0062 interim (superseded by work_unit); still read for back-compat. */
  topology?: string;
  /** ADR-0064 [stage] schema block: `values = [...]`, `monotonic = true`. */
  stage?: { values?: unknown; monotonic?: unknown };
  /** Pin this role's cmux workspace on resume-cluster (core singletons pin to the top of the
   * sidebar; fleet workers leave it unset). Default false. */
  pin_on_resume?: unknown;
  /** Role accent color as `#RRGGBB` hex — ONE source of truth for both the ccs TUI role column
   * and the cmux tab color (so they render identical bytes). Malformed → treated as absent. */
  color?: unknown;
}

/** Read a role dir into a RoleDef. `dir` is the role's home; `cluster` is its grouping or null. */
export function readRoleDir(dir: string, role: string, cluster: string | null): RoleDef | null {
  if (!existsSync(dir)) return null;
  let toml: RoleToml = {};
  const tomlPath = join(dir, "role.toml");
  if (existsSync(tomlPath)) {
    try {
      toml = parseToml(readFileSync(tomlPath, "utf8")) as RoleToml;
    } catch {
      toml = {}; // malformed toml → treat as empty manifest (fail-open; lint surfaces it)
    }
  }
  const kind: Kind | null = toml.kind === "loop" ? "loop" : toml.kind === "session" ? "session" : null;
  // ADR-0069: work_unit anchor type is authoritative; fall back to the interim ADR-0062 topology
  // (core→none, fleet→freeform) for a role.toml not yet migrated. null when neither is declared.
  const ANCHORS = new Set(["pr", "gus", "freeform", "none"]);
  let workUnit: WorkUnitAnchorType | null =
    typeof toml.work_unit === "string" && ANCHORS.has(toml.work_unit) ? (toml.work_unit as WorkUnitAnchorType) : null;
  if (!workUnit) {
    if (toml.topology === "core") workUnit = "none";
    else if (toml.topology === "fleet") workUnit = "freeform";
  }
  // ADR-0064: role-declared stage schema. Only a [stage] block with a string[] `values` counts;
  // anything malformed → null (unconstrained), fail-open like the rest of role.toml parsing.
  let stageSchema: StageSchema | null = null;
  const sv = toml.stage?.values;
  if (Array.isArray(sv) && sv.every((v) => typeof v === "string")) {
    stageSchema = { values: sv as string[], monotonic: toml.stage?.monotonic === true };
  }
  return {
    role,
    cluster,
    kind,
    workUnit,
    homeDir: dir, // computed at load — the portability breaker (stored absolute path) is gone
    resumeCommand: toml.resume_command ?? null,
    stageSchema,
    pinOnResume: toml.pin_on_resume === true,
    color: typeof toml.color === "string" && /^#[0-9a-fA-F]{6}$/.test(toml.color) ? toml.color : null,
    // ADR-0074: skills + commands read from PROJECT-LOCAL .claude/ (Claude Code discovers them
    // from the role's cwd), with a fallback to the legacy top-level locations (so nothing breaks
    // before the config-side file moves). Hooks remain in .ccs-hooks (never project-local).
    skills: dirNames(join(dir, ".claude", "skills")).length
      ? dirNames(join(dir, ".claude", "skills"))
      : dirNames(join(dir, "skills")),
    commands: commandNames(join(dir, ".claude", "commands")).length
      ? commandNames(join(dir, ".claude", "commands"))
      : commandNames(join(dir, "commands")),
    hooks: hookNames(join(dir, ".ccs-hooks")),
    updatedAt: null,
  };
}

/** Sub-directory / entry names under a dir (skills are dirs or files), sorted. */
function dirNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
}

/** Command base-names: `<name>.md` → `<name>`. */
function commandNames(dir: string): string[] {
  return dirNames(dir).filter((n) => n.endsWith(".md")).map((n) => n.slice(0, -3));
}

/** Hook-type names present in .ccs-hooks/: `<type>.{md,json}` → `<type>` (deduped). */
function hookNames(dir: string): string[] {
  const seen = new Set<string>();
  for (const n of dirNames(dir)) {
    const dot = n.lastIndexOf(".");
    if (dot > 0) seen.add(n.slice(0, dot));
  }
  return [...seen].sort();
}

/**
 * Resolve ONE role. ADR-D3 (2026-07-14): role identity is (cluster, role), not global-by-name.
 *
 * Signatures accepted:
 *   resolveRole(role)                        → legacy first-match scan (warns on collision)
 *   resolveRole(role, cluster)               → strict (cluster, role) — cluster="" or omitted falls back
 *   resolveRole(role, cluster, configRoot)   → strict + custom root
 *   resolveRole(role, configRoot)            → legacy overload used by tests that pass a path
 *
 * `configRoot` is detected by looking for a path separator; anything else is `cluster`. Null
 * cluster = "standalone-only lookup".
 */
export function resolveRole(
  role: string,
  clusterOrConfigRoot?: string | null,
  configRoot?: string,
): RoleDef | null {
  // Overload detection: if the second arg contains a path separator, treat it as configRoot.
  // (No real cluster name should contain a "/" — cluster names are single directory basenames.)
  let cluster: string | null | undefined;
  let root: string;
  if (typeof clusterOrConfigRoot === "string" && clusterOrConfigRoot.includes("/")) {
    root = clusterOrConfigRoot;
    cluster = undefined;
  } else {
    cluster = clusterOrConfigRoot;
    root = configRoot ?? ccsConfigRoot();
  }
  return _resolveRole(role, cluster, root);
}

function _resolveRole(role: string, cluster: string | null | undefined, configRoot: string): RoleDef | null {
  const clustersRoot = join(configRoot, "clusters");
  // Cluster-scoped lookup: look ONLY in the given cluster's roles/, no fall-through.
  if (cluster) {
    const dir = join(clustersRoot, cluster, "roles", role);
    if (existsSync(dir)) return readRoleDir(dir, role, cluster);
    return null;
  }
  // Explicit standalone lookup: cluster === null means "not attached to a cluster".
  if (cluster === null) {
    const standalone = join(configRoot, "roles", role);
    if (existsSync(standalone)) return readRoleDir(standalone, role, null);
    return null;
  }
  // Legacy path (cluster undefined). Warn if a second cluster ALSO defines this role — that's
  // exactly the collision this ADR is designed to catch.
  const hits: Array<{ dir: string; cluster: string | null }> = [];
  if (existsSync(clustersRoot)) {
    for (const c of dirNames(clustersRoot)) {
      const dir = join(clustersRoot, c, "roles", role);
      if (existsSync(dir)) hits.push({ dir, cluster: c });
    }
  }
  const standalone = join(configRoot, "roles", role);
  if (existsSync(standalone)) hits.push({ dir: standalone, cluster: null });
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    // Loud but non-fatal: this call site needs updating to pass a cluster.
    // Kept warn-only for now so a partial migration doesn't blow up production.
    console.error(
      `ccs: resolveRole("${role}") is ambiguous — found in ${hits.length} places ` +
      `(${hits.map((h) => h.cluster ?? "standalone").join(", ")}). ` +
      `Pass cluster to disambiguate. Using the first match: ${hits[0]!.cluster ?? "standalone"}.`,
    );
  }
  const pick = hits[0]!;
  return readRoleDir(pick.dir, role, pick.cluster);
}

/** Every role across every cluster + standalone, as a name→RoleDef map. NOTE (ADR-D3): keyed by
 * role NAME alone, so two clusters with a role of the same name collide — the alphabetical-first
 * cluster's role wins. Callers that need the full list without deduplication use `allRolesFlat`
 * below. The name-keyed variant is preserved for callers (tui/theme, sync-roles) that only need
 * one entry per name and can tolerate the collision on the current single-cluster machine. */
export function allRolesFromFiles(configRoot = ccsConfigRoot()): Map<string, RoleDef> {
  const out = new Map<string, RoleDef>();
  const clustersRoot = join(configRoot, "clusters");
  if (existsSync(clustersRoot)) {
    for (const cluster of dirNames(clustersRoot)) {
      const rolesDir = join(clustersRoot, cluster, "roles");
      if (!existsSync(rolesDir)) continue;
      for (const role of dirNames(rolesDir)) {
        if (!isDir(join(rolesDir, role))) continue;
        const def = readRoleDir(join(rolesDir, role), role, cluster);
        if (!def) continue;
        // Two clusters defining a role with the same NAME (e.g. `control` in both pr-watch and
        // toy-second) collide in this name-keyed map. Prefer the entry that carries more
        // information: keep the existing one if it has a color and the new one doesn't. This
        // fixes the "control shows gray in the TUI" bug that appeared once a second cluster
        // (with no color assigned) was onboarded. Callers that need per-cluster resolution
        // should use `allRolesFlat` instead.
        const prev = out.get(role);
        if (prev && prev.color && !def.color) continue;
        out.set(role, def);
      }
    }
  }
  const standaloneRoot = join(configRoot, "roles");
  if (existsSync(standaloneRoot)) {
    for (const role of dirNames(standaloneRoot)) {
      if (!isDir(join(standaloneRoot, role)) || out.has(role)) continue;
      const def = readRoleDir(join(standaloneRoot, role), role, null);
      if (def) out.set(role, def);
    }
  }
  return out;
}

/** Every role across every cluster + standalone, as a flat list — NO deduplication by name.
 * Two clusters both defining a role named `control` appear as TWO entries here. This is the
 * correct shape for `ccs roles ls` under ADR-D3 (role identity is (cluster, role), not name).
 * Order: cluster roles first (alphabetical by cluster then role), then standalone. */
export function allRolesFlat(configRoot = ccsConfigRoot()): RoleDef[] {
  const out: RoleDef[] = [];
  const clustersRoot = join(configRoot, "clusters");
  if (existsSync(clustersRoot)) {
    for (const cluster of dirNames(clustersRoot)) {
      const rolesDir = join(clustersRoot, cluster, "roles");
      if (!existsSync(rolesDir)) continue;
      for (const role of dirNames(rolesDir)) {
        if (!isDir(join(rolesDir, role))) continue;
        const def = readRoleDir(join(rolesDir, role), role, cluster);
        if (def) out.push(def);
      }
    }
  }
  const standaloneRoot = join(configRoot, "roles");
  if (existsSync(standaloneRoot)) {
    for (const role of dirNames(standaloneRoot)) {
      if (!isDir(join(standaloneRoot, role))) continue;
      const def = readRoleDir(join(standaloneRoot, role), role, null);
      if (def) out.push(def);
    }
  }
  return out;
}

/** All roles belonging to a cluster. */
export function rolesForClusterFromFiles(cluster: string, configRoot = ccsConfigRoot()): RoleDef[] {
  const rolesDir = join(configRoot, "clusters", cluster, "roles");
  if (!existsSync(rolesDir)) return [];
  const out: RoleDef[] = [];
  for (const role of dirNames(rolesDir)) {
    if (!isDir(join(rolesDir, role))) continue;
    const def = readRoleDir(join(rolesDir, role), role, cluster);
    if (def) out.push(def);
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
