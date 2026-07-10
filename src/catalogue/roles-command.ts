/**
 * `ccs roles` — manage the roles registry (ADR-0022): list / upsert / rm.
 * The registry is the source of truth for role DEFINITIONS that sync-roles materializes
 * and resume uses. A role can optionally belong to a cluster.
 */
import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import {
  openCatalogue,
  upsertRole,
  deleteRole,
  allRoles,
  rolesForCluster,
  getRoleDef,
  type Kind,
} from "./db.ts";

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Read `--flag value`; returns undefined if absent or followed by another flag. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

/** Read a repeatable/comma-list flag into a string[] (e.g. --skills a,b or --skills a --skills b). */
function listFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] && !args[i + 1]!.startsWith("--")) {
      out.push(...args[i + 1]!.split(",").map((s) => s.trim()).filter(Boolean));
    }
  }
  return out;
}

export function rolesCommand(args: string[]): number {
  const sub = args[0];
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    switch (sub) {
      case undefined:
      case "ls":
      case "list": {
        const cluster = flag(args, "--cluster");
        const roles = cluster ? rolesForCluster(db, cluster) : [...allRoles(db).values()];
        if (roles.length === 0) {
          console.log("no roles defined. Add one with `ccs roles upsert <role> [--cluster …] …`");
          return 0;
        }
        for (const r of roles) {
          const bits = [
            r.cluster ? `cluster=${r.cluster}` : "no-cluster",
            r.kind ?? "?",
            r.resumeCommand ? `resume=${JSON.stringify(r.resumeCommand)}` : "no-resume",
          ];
          console.log(`${r.role.padEnd(16)} ${bits.join("  ")}`);
        }
        return 0;
      }
      case "upsert": {
        const role = args[1];
        if (!role || role.startsWith("--")) {
          console.error("usage: ccs roles upsert <role> [--cluster <c>] [--kind loop|session] [--home <dir>] [--resume-command <cmd>] [--skills a,b] [--commands a,b] [--hooks a,b]");
          return 1;
        }
        const kindRaw = flag(args, "--kind");
        upsertRole(db, {
          role,
          cluster: flag(args, "--cluster") ?? null,
          kind: (kindRaw === "loop" ? "loop" : kindRaw === "session" ? "session" : null) as Kind | null,
          homeDir: flag(args, "--home") ?? null,
          resumeCommand: flag(args, "--resume-command") ?? null,
          skills: listFlag(args, "--skills"),
          commands: listFlag(args, "--commands"),
          hooks: listFlag(args, "--hooks"),
          now: now(),
        });
        console.log(`role ${role} upserted`);
        return 0;
      }
      case "rm":
      case "delete": {
        const role = args[1];
        if (!role) {
          console.error("usage: ccs roles rm <role>");
          return 1;
        }
        if (!getRoleDef(db, role)) {
          console.error(`ccs: no such role "${role}"`);
          return 1;
        }
        deleteRole(db, role);
        console.log(`role ${role} removed`);
        return 0;
      }
      default:
        console.error(`ccs roles: unknown subcommand "${sub}" (ls | upsert | rm)`);
        return 1;
    }
  } finally {
    db.close();
  }
}
