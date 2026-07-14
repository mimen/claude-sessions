import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ccsConfigRoot } from "../roles/role-files.ts";

/**
 * `ccs cluster init <name>` — scaffold a minimal cluster package.
 *
 * The wizard is DELIBERATELY MINIMAL (per the 2026-07-14 shareability plan). It creates the
 * three files a cluster CANNOT exist without: cluster.toml (manifest with a version contract),
 * CHANGELOG.md (the monotonic version log the manifest resolves against), and one role dir
 * (an empty scaffold — the user fills in the skill + hooks per their loop's shape).
 *
 * What it INTENTIONALLY doesn't do: seed an engine, wire hooks, generate roles beyond the
 * placeholder, mint a runtime state dir, or install anything. Those are cluster-specific
 * decisions and the shape of a well-formed cluster varies enough (pr-watch has a Python engine,
 * a future toy cluster might have no engine at all) that a wizard prescribing them would
 * either be wrong for most cases or bloat with per-cluster branches.
 *
 * Usage: `ccs cluster init <name> [--role <role-slug>] [--config-root <path>]`
 * Defaults: role slug = "loop", config-root = $CCS_CONFIG_ROOT or ~/.ccs-config.
 */
export function clusterInitCommand(args: string[]): number {
  const name = args[0];
  if (!name || name.startsWith("-")) {
    console.error("ccs cluster init: missing cluster name.");
    console.error("Usage: ccs cluster init <name> [--role <role-slug>] [--config-root <path>]");
    return 1;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
    console.error(`ccs cluster init: '${name}' is not a valid cluster slug.`);
    console.error("Slugs are 1-63 chars: lowercase letters, digits, `.`, `_`, `-`; must start alphanumeric.");
    return 1;
  }
  const roleIdx = args.indexOf("--role");
  const role = roleIdx >= 0 ? args[roleIdx + 1] : "loop";
  const rootIdx = args.indexOf("--config-root");
  const root = rootIdx >= 0 ? args[rootIdx + 1]! : ccsConfigRoot();

  const clusterDir = join(root, "clusters", name);
  if (existsSync(clusterDir)) {
    console.error(`ccs cluster init: ${clusterDir} already exists. Refusing to overwrite.`);
    return 2;
  }

  const roleDir = join(clusterDir, "roles", role!);
  mkdirSync(join(roleDir, ".claude", "skills", role!), { recursive: true });
  mkdirSync(join(roleDir, ".ccs-hooks"), { recursive: true });

  writeFileSync(join(clusterDir, "cluster.toml"), renderClusterToml(name));
  writeFileSync(join(clusterDir, "CHANGELOG.md"), renderChangelog(name));
  writeFileSync(join(roleDir, ".claude", "skills", role!, "SKILL.md"), renderSkillPlaceholder(name, role!));

  console.log(`created cluster '${name}' at ${clusterDir}`);
  console.log("  cluster.toml       manifest (version contract + engine paths)");
  console.log("  CHANGELOG.md       monotonic version log (this is the cluster's OWN version)");
  console.log(`  roles/${role}/       first role — fill in .claude/skills/${role}/SKILL.md`);
  console.log("");
  console.log("Next: edit the SKILL, add an engine (or don't), commit, and register with:");
  console.log(`  ccs role . ${role} && ccs system . ${name}`);
  return 0;
}

function renderClusterToml(name: string): string {
  return `# The ${name} cluster manifest. A cluster is a self-contained package: role definitions,
# an executable engine (optional), and this manifest. Runtime state lives in ~/.ccs/clusters/${name}
# (never in this repo). Clone this dir anywhere and it runs.
name = "${name}"

# Minimum ccs version this cluster depends on. The tool refuses on a major-version gap and warns
# on a minor one, so a tool/config schema skew fails loud instead of silently.
requires_ccs = ">=0.1.0"

# The cluster's mid-level GROUPING TYPE (ADR-0070). Common shapes: "epic" (work items grouped
# under a project epic), "sprint", "topic". Purely a display hint — the entity stays generic.
grouping_type = "epic"

# Optional executable engine. Delete these lines if this cluster has no engine (a wrapper-only
# cluster whose work is entirely inside role skills is a legitimate shape).
# engine = "engine"
# sense = "engine/scripts/sense.sh"
# board = "engine/scripts/compose_board.py"
`;
}

function renderChangelog(name: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `# ${name} — CHANGELOG

The highest-numbered entry here IS this cluster's version (ADR-0058). Add a new entry when you
change the cluster's shape (schema, contract, hook set, role roster). The tool reads the latest
entry to gate against \`requires_ccs\` and to render "since you last resumed, this changed" on
catch-up.

## v1 — ${today} — initial scaffold

Bootstrapped by \`ccs cluster init\`. One role, no engine yet. Fill in the role skill,
optionally add an engine, and re-version to v2 when the shape stabilizes.
`;
}

function renderSkillPlaceholder(cluster: string, role: string): string {
  return `# ${role} (${cluster})

Placeholder skill for the \`${role}\` role in the \`${cluster}\` cluster. Replace this file with
the role's actual instructions — what it senses, what it does, and what it never does.

## What this role does

<!-- one paragraph — the role's job in the cluster's loop. -->

## Every turn

<!-- an ordered checklist the agent runs at the start of each turn. -->

## Constraints

<!-- what this role NEVER does; boundaries with sibling roles. -->
`;
}
