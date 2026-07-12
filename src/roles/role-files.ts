import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { RoleDef, Kind, Topology } from "../catalogue/db.ts";

/**
 * File-backed role definitions (ADR-0048/0050): a role is a directory in a cluster package;
 * its definition is READ FROM FILES, not a sqlite table. This is the source of truth.
 *
 * A role dir holds only `role.toml` carrying the non-derivable metadata — `kind` +
 * `resume_command`. Everything else is DERIVED:
 *   - role name   = the directory name
 *   - cluster     = the parent path (clusters/<cluster>/roles/<role>) or null (standalone)
 *   - home_dir    = the directory itself (computed at load — NEVER a stored absolute path)
 *   - skills[]    = names present under <role>/skills/
 *   - commands[]  = base-names of *.md present under <role>/commands/
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
  topology?: string;
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
  const topology: Topology | null =
    toml.topology === "core" ? "core" : toml.topology === "fleet" ? "fleet" : null;
  return {
    role,
    cluster,
    kind,
    topology,
    homeDir: dir, // computed at load — the portability breaker (stored absolute path) is gone
    resumeCommand: toml.resume_command ?? null,
    skills: dirNames(join(dir, "skills")),
    commands: commandNames(join(dir, "commands")),
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

/** Resolve ONE role by name across the config tree (cluster roles first, then standalone). */
export function resolveRole(role: string, configRoot = ccsConfigRoot()): RoleDef | null {
  const clustersRoot = join(configRoot, "clusters");
  if (existsSync(clustersRoot)) {
    for (const cluster of dirNames(clustersRoot)) {
      const dir = join(clustersRoot, cluster, "roles", role);
      if (existsSync(dir)) return readRoleDir(dir, role, cluster);
    }
  }
  const standalone = join(configRoot, "roles", role);
  if (existsSync(standalone)) return readRoleDir(standalone, role, null);
  return null;
}

/** Every role across every cluster + standalone, as a name→RoleDef map. */
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
        if (def) out.set(role, def);
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
