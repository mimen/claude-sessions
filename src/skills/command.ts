import { loadConfig } from "../config.ts";
import { ensureDataDir, SKILLS_DB_PATH } from "../paths.ts";
import { discoverSkills, type SkillRecord } from "./scan.ts";
import { openSkillsDb, saveSkills, loadSkills, usageTotals, tagsFor, addTag, removeTag } from "./db.ts";
import { mineUsage } from "./usage.ts";

const HELP = `ccs skills — machine-wide skill registry with real usage data

Usage:
  ccs skills                 List skills (Claude ecosystems by default) with usage
  ccs skills --all           Include every ecosystem (codex, cursor, hermes, archives…)
  ccs skills --eco <name>    Filter to one ecosystem (claude-user, claude-project, agents,
                             plugin, codex, cursor, hermes, archive, download, other)
  ccs skills --tag <tag>     Filter to skills carrying a tag
  ccs skills --unused        Only skills with zero observed usage (candidates for pruning)
  ccs skills --paths         Show each skill's primary path
  ccs skills --rescan        Re-run full-machine discovery (otherwise cached registry)
  ccs skills --json          Full records as JSON (paths, aliases, descriptions, usage, tags)
  ccs skills tag <name> <tag…> [--remove]   Add/remove organization tags

Usage columns: inv = Skill-tool invocations · cmd = slash commands · read = SKILL.md/doc reads.
Counts come from this machine's transcript Store only — "0" means unobserved here, not dead.
`;

const DEFAULT_ECOSYSTEMS = new Set(["claude-user", "claude-project", "agents", "plugin"]);

export async function skillsCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "tag") return tagCommand(args.slice(1));
  return list({
    all: args.includes("--all"),
    eco: flagValue(args, "--eco"),
    tag: flagValue(args, "--tag"),
    unused: args.includes("--unused"),
    paths: args.includes("--paths"),
    rescan: args.includes("--rescan"),
    json: args.includes("--json"),
  });
}

interface ListOpts {
  all: boolean;
  eco?: string;
  tag?: string;
  unused: boolean;
  paths: boolean;
  rescan: boolean;
  json: boolean;
}

async function list(opts: ListOpts): Promise<number> {
  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(configResult.error.message);
    return 1;
  }
  ensureDataDir();
  const db = openSkillsDb(SKILLS_DB_PATH);
  try {
    let skills = loadSkills(db);
    if (skills.length === 0 || opts.rescan) {
      process.stderr.write("Scanning the machine for skills… ");
      const found = await discoverSkills();
      if (!found.ok) {
        console.error(found.error.message);
        return 1;
      }
      saveSkills(db, found.value);
      skills = found.value;
      process.stderr.write(`${skills.length} found\n`);
    }

    // Usage join: every known skill dir (primary + aliases + realpath) maps to its slug.
    const dirsToName = new Map<string, string>();
    for (const s of skills) {
      dirsToName.set(s.path, s.name);
      dirsToName.set(s.realPath, s.name);
      for (const a of s.aliases) dirsToName.set(a, s.name);
    }
    const tty = process.stderr.isTTY === true;
    const mined = await mineUsage(db, configResult.value.store.path, dirsToName, (done, total) => {
      if (tty && total > 20) process.stderr.write(`\rMining transcripts… ${done}/${total}   `);
    });
    if (tty && mined.parsed > 20) process.stderr.write("\n");

    const usage = usageTotals(db);
    const tags = tagsFor(db);

    let rows = skills;
    if (opts.eco) rows = rows.filter((s) => s.ecosystem === opts.eco);
    else if (!opts.all) rows = rows.filter((s) => DEFAULT_ECOSYSTEMS.has(s.ecosystem));
    if (opts.tag) rows = rows.filter((s) => (tags.get(s.name) ?? []).includes(opts.tag!));
    if (opts.unused) rows = rows.filter((s) => !usage.has(s.name));

    // Plugin caches and vendored copies produce several physical dirs for one logical skill;
    // the table collapses same (name, ecosystem) rows into one line with a copy count.
    const grouped = new Map<string, SkillRecord & { copies: number }>();
    for (const s of rows) {
      const key = `${s.name}\x00${s.ecosystem}`;
      const g = grouped.get(key);
      if (g) g.copies++;
      else grouped.set(key, { ...s, copies: 1 });
    }
    const display = [...grouped.values()];

    if (opts.json) {
      console.log(
        JSON.stringify(
          rows.map((s) => ({ ...s, tags: tags.get(s.name) ?? [], usage: usage.get(s.name) ?? null })),
          null,
          2,
        ),
      );
      return 0;
    }

    display.sort((a, b) => {
      const ua = usage.get(a.name)?.lastUsed ?? "";
      const ub = usage.get(b.name)?.lastUsed ?? "";
      if (ua !== ub) return ub.localeCompare(ua);
      return a.name.localeCompare(b.name);
    });

    const header = [
      pad("SKILL", 30),
      pad("ECOSYSTEM", 15),
      pad("TAGS", 18),
      padLeft("INV", 5),
      padLeft("CMD", 5),
      padLeft("READ", 5),
      pad("LAST-USED", 11),
    ];
    if (opts.paths) header.push("PATH");
    console.log(header.join(" "));

    for (const s of display) {
      const u = usage.get(s.name);
      const t = tags.get(s.name) ?? [];
      const cols = [
        pad(s.name + (s.copies > 1 ? ` ×${s.copies}` : ""), 30),
        pad(s.ecosystem, 15),
        pad(t.join(","), 18),
        padLeft(u ? String(u.invocations) : "·", 5),
        padLeft(u ? String(u.commands) : "·", 5),
        padLeft(u ? String(u.reads) : "·", 5),
        pad(u?.lastUsed ? u.lastUsed.slice(0, 10) : "unobserved", 11),
      ];
      if (opts.paths) cols.push(s.path);
      console.log(cols.join(" "));
    }

    const unobserved = display.filter((s) => !usage.has(s.name)).length;
    console.log(
      `\n${display.length} skills (${unobserved} unobserved) · INV=Skill invocations CMD=slash commands READ=doc reads` +
        ` · this machine's Store only` +
        (opts.all || opts.eco ? "" : " · default view hides codex/cursor/hermes/archive (--all)"),
    );
    return 0;
  } finally {
    db.close();
  }
}

function tagCommand(args: string[]): number {
  const remove = args.includes("--remove");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [name, ...tagList] = positional;
  if (!name || tagList.length === 0) {
    console.error("Usage: ccs skills tag <name> <tag…> [--remove]");
    return 1;
  }
  ensureDataDir();
  const db = openSkillsDb(SKILLS_DB_PATH);
  try {
    const known = new Set(loadSkills(db).map((s) => s.name));
    if (!known.has(name)) {
      console.error(`Unknown skill "${name}" — not in the registry (run \`ccs skills --rescan\` if it's new).`);
      return 1;
    }
    for (const tag of tagList) {
      if (remove) removeTag(db, name, tag);
      else addTag(db, name, tag);
    }
    console.log(`${remove ? "Removed" : "Tagged"} ${name}: ${tagList.join(", ")}`);
    return 0;
  } finally {
    db.close();
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function pad(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width - 1) + "…" : text;
  return t.padEnd(width);
}

function padLeft(text: string, width: number): string {
  return text.length > width ? text.slice(0, width) : text.padStart(width);
}
