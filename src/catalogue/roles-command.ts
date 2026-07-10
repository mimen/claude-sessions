/**
 * `ccs roles` — inspect / author role DEFINITIONS (ADR-0048/0050).
 * Role definitions are FILES in the config package (`~/.ccs-config/clusters/<c>/roles/<role>/
 * role.toml`); there is no sqlite registry. `ls` reads the files; `upsert` writes a role.toml
 * (creating the package dir); `rm` removes the role dir. Skills/commands/hooks are NOT flags —
 * they're file-presence in the role dir (author them there, then `ccs sync-roles`).
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ccsConfigRoot, allRolesFromFiles, rolesForClusterFromFiles, resolveRole } from "../roles/role-files.ts";

/** Read `--flag value`; undefined if absent or followed by another flag. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

/** The dir a role's package lives in: clusters/<c>/roles/<role> or standalone roles/<role>. */
function roleDir(role: string, cluster: string | null): string {
  const root = ccsConfigRoot();
  return cluster ? join(root, "clusters", cluster, "roles", role) : join(root, "roles", role);
}

export function rolesCommand(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const cluster = flag(args, "--cluster");
      const roles = cluster ? rolesForClusterFromFiles(cluster) : [...allRolesFromFiles().values()];
      if (roles.length === 0) {
        console.log("no roles defined. Add one with `ccs roles upsert <role> [--cluster …] --kind loop|session`");
        return 0;
      }
      for (const r of roles) {
        const bits = [
          r.cluster ? `cluster=${r.cluster}` : "no-cluster",
          r.kind ?? "?",
          r.resumeCommand ? `resume=${JSON.stringify(r.resumeCommand)}` : "no-resume",
          r.skills.length ? `skills=${r.skills.join(",")}` : "",
        ].filter(Boolean);
        console.log(`${r.role.padEnd(16)} ${bits.join("  ")}`);
      }
      return 0;
    }
    case "upsert": {
      const role = args[1];
      if (!role || role.startsWith("--")) {
        console.error("usage: ccs roles upsert <role> [--cluster <c>] [--kind loop|session] [--resume-command <cmd>]");
        console.error("  (skills/commands/hooks are file-presence in the role dir, not flags)");
        return 1;
      }
      const cluster = flag(args, "--cluster") ?? null;
      const kindRaw = flag(args, "--kind");
      const kind = kindRaw === "loop" ? "loop" : kindRaw === "session" ? "session" : null;
      const resume = flag(args, "--resume-command") ?? null;
      const dir = roleDir(role, cluster);
      mkdirSync(dir, { recursive: true });
      // role.toml carries ONLY the non-derivable metadata (ADR-0048): kind + resume_command.
      const lines: string[] = [];
      if (kind) lines.push(`kind = "${kind}"`);
      if (resume) lines.push(`resume_command = ${JSON.stringify(resume)}`);
      writeFileSync(join(dir, "role.toml"), lines.join("\n") + "\n");
      console.log(`role ${role} written → ${dir}/role.toml`);
      console.log(`  (add skills/ commands/ .ccs-hooks/ in that dir, then \`ccs sync-roles\`)`);
      return 0;
    }
    case "rm":
    case "delete": {
      const role = args[1];
      if (!role) {
        console.error("usage: ccs roles rm <role>");
        return 1;
      }
      const def = resolveRole(role);
      if (!def) {
        console.error(`ccs: no such role "${role}"`);
        return 1;
      }
      if (def.homeDir && existsSync(def.homeDir)) rmSync(def.homeDir, { recursive: true, force: true });
      console.log(`role ${role} removed (${def.homeDir}); run \`ccs sync-roles\` to prune its materialized links`);
      return 0;
    }
    default:
      console.error(`ccs roles: unknown subcommand "${sub}" (ls | upsert | rm)`);
      return 1;
  }
}
