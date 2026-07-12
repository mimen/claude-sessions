import { loadConfig } from "../config.ts";
import { ensureDataDir, SKILLS_DB_PATH } from "../paths.ts";
import { discoverSkills, isInLinkedWorktree, type SkillRecord } from "./scan.ts";
import { shadowDuplicatePaths, accessIn, contextLabel, type SkillContext } from "./view.ts";
import { homedir } from "node:os";
import { openSkillsDb, saveSkills, loadSkills, usageTotals, tagsFor, addTag, removeTag, setCategory, categoriesFor } from "./db.ts";
import { mineUsage } from "./usage.ts";

const HELP = `ccs skills — every skill on this machine, with real usage numbers

Usage:
  ccs skills                 List skills (Claude ecosystems by default) with usage
  ccs skills --all           Include every ecosystem (codex, cursor, hermes, archives…)
  ccs skills --eco <name>    Filter to one ecosystem (see glossary below)
  ccs skills --tag <tag>     Filter to skills carrying a tag
  ccs skills --unused        Only skills with zero observed usage (candidates for pruning)
  ccs skills --worktrees     Include git-worktree copies (hidden by default — each worktree
                             checkout duplicates its repo's skills)
  ccs skills --context <c>   Only skills a session in that context can actually load, with an
                             ACCESS column saying how. Contexts: claude (Claude Code @ ~),
                             claude:<path> (Claude Code started in <path>), codex, hermes,
                             cursor, agents
  ccs skills --paths         Show each skill's primary path
  ccs skills --rescan        Re-run full-machine discovery (otherwise cached registry)
  ccs skills --json          Full records as JSON (paths, aliases, descriptions, usage, tags)
  ccs skills tag <name> <tag…> [--remove]   Add/remove organization tags
  ccs skills category <name> <category>     Set the skill's single curated category
  ccs skills category <name> --clear        Clear it

Bare \`ccs skills\` on a terminal opens the interactive TUI (skills mode); piped output
or any flag/subcommand gives this plain table instead.

Columns — three different ways a skill gets used:
  INVOKED   Claude ran the skill (Skill tool call mid-conversation)
  SLASH     fired as a /command — by you, or by a loop re-prompting itself
  READS     a session opened the skill's files as reference docs without running it
            (loops do this constantly; a skill can be load-bearing with zero INVOKED)
  LAST-USED most recent of any of the three signals

Ecosystem — which agent's skill folder the skill lives in:
  claude-user      your global Claude Code skills (~/.claude/skills, i.e. ClaudeConfig)
  claude-project   a repo or workspace's local .claude/skills
  plugin           installed Claude Code plugins/marketplaces
  agents           ~/.agents/skills (the cross-tool Agent Skills standard dir)
  codex / cursor / hermes   the other agent tools' own skill folders
  archive / download        dead copies (vault _archive, ~/Downloads)

All counts come from this machine's Claude transcripts only — zero means "not observed
here", not "dead". Codex/Cursor/Hermes usage and the Mac Mini aren't mined (yet).
`;

const DEFAULT_ECOSYSTEMS = new Set(["claude-user", "claude-project", "agents", "plugin"]);

export async function skillsCommand(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  if (args[0] === "tag") return tagCommand(args.slice(1));
  if (args[0] === "category") return categoryCommand(args.slice(1));
  return list({
    all: args.includes("--all"),
    eco: flagValue(args, "--eco"),
    tag: flagValue(args, "--tag"),
    unused: args.includes("--unused"),
    paths: args.includes("--paths"),
    rescan: args.includes("--rescan"),
    json: args.includes("--json"),
    worktrees: args.includes("--worktrees"),
    context: parseContext(flagValue(args, "--context")),
  });
}

/** Parse a --context value into a SkillContext; unknown values fall back to null (no lens). */
function parseContext(raw: string | undefined): SkillContext | null {
  if (!raw) return null;
  if (raw === "claude") return { kind: "claude", cwd: homedir() };
  if (raw.startsWith("claude:")) {
    const p = raw.slice("claude:".length);
    return { kind: "claude", cwd: p.startsWith("~") ? homedir() + p.slice(1) : p };
  }
  if (raw === "codex" || raw === "hermes" || raw === "cursor" || raw === "agents") return { kind: raw };
  console.error(`Unknown context "${raw}" — use claude, claude:<path>, codex, hermes, cursor, or agents.`);
  return null;
}

interface ListOpts {
  all: boolean;
  eco?: string;
  tag?: string;
  unused: boolean;
  paths: boolean;
  rescan: boolean;
  json: boolean;
  worktrees: boolean;
  context: SkillContext | null;
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
    const categories = categoriesFor(db);

    let rows = skills;
    // Context lens: keep only skills a session in that context can load; remember how.
    const accessByPath = new Map<string, string>();
    if (opts.context) {
      rows = rows.filter((s) => {
        const access = accessIn(s, opts.context!);
        if (access) accessByPath.set(s.path, access);
        return !!access;
      });
    }
    let dupesHidden = 0;
    if (!opts.worktrees && !opts.context) {
      const cache = new Map<string, boolean>();
      const shadows = shadowDuplicatePaths(rows);
      const before = rows.length;
      rows = rows.filter((s) => s.ecosystem !== "marketplace" && !shadows.has(s.path) && !isInLinkedWorktree(s.realPath, cache));
      dupesHidden = before - rows.length;
    }
    if (opts.eco) rows = rows.filter((s) => s.ecosystem === opts.eco);
    else if (!opts.all && !opts.context) rows = rows.filter((s) => DEFAULT_ECOSYSTEMS.has(s.ecosystem));
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
          rows.map((s) => ({
          ...s,
          category: s.category ?? categories.get(s.name) ?? null,
          tags: tags.get(s.name) ?? [],
          usage: usage.get(s.name) ?? null,
          ...(opts.context ? { access: accessByPath.get(s.path) ?? null } : {}),
        })),
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
      pad(opts.context ? "ACCESS" : "ECOSYSTEM", opts.context ? 24 : 15),
      pad("CATEGORY", 13),
      pad("TAGS", 14),
      padLeft("INVOKED", 8),
      padLeft("SLASH", 6),
      padLeft("READS", 6),
      pad("LAST-USED", 11),
    ];
    if (opts.paths) header.push("PATH");
    console.log(header.join(" "));

    for (const s of display) {
      const u = usage.get(s.name);
      const t = tags.get(s.name) ?? [];
      const cols = [
        pad(s.name + (s.copies > 1 ? ` ×${s.copies}` : ""), 30),
        opts.context ? pad(accessByPath.get(s.path) ?? "", 24) : pad(s.ecosystem, 15),
        pad(s.category ?? categories.get(s.name) ?? "", 13),
        pad(t.join(","), 14),
        padLeft(u ? String(u.invocations) : "·", 8),
        padLeft(u ? String(u.commands) : "·", 6),
        padLeft(u ? String(u.reads) : "·", 6),
        pad(u?.lastUsed ? u.lastUsed.slice(0, 10) : "unobserved", 11),
      ];
      if (opts.paths) cols.push(s.path);
      console.log(cols.join(" "));
    }

    const unobserved = display.filter((s) => !usage.has(s.name)).length;
    console.log(
      `\n${display.length} skills${opts.context ? ` accessible in context ${contextLabel(opts.context)}` : ""}, ${unobserved} never observed in use.` +
        `\nINVOKED = Claude ran it · SLASH = fired as a /command (you or a loop) · READS = opened as reference docs.` +
        `\nCounts are from this Mac's Claude transcripts only — zero here doesn't prove a skill is dead.` +
        (dupesHidden > 0 ? `\n${dupesHidden} duplicate copies hidden — worktree checkouts + identical shadow copies (--worktrees to include).` : "") +
        (opts.all || opts.eco ? "" : `\nHidden by default: codex/cursor/hermes/archive skills (use --all). Glossary: ccs skills --help`),
    );
    return 0;
  } finally {
    db.close();
  }
}

function categoryCommand(args: string[]): number {
  const clear = args.includes("--clear");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [name, category] = positional;
  if (!name || (!category && !clear)) {
    console.error("Usage: ccs skills category <name> <category> | ccs skills category <name> --clear");
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
    setCategory(db, name, clear ? null : category!);
    console.log(clear ? `Cleared category on ${name}` : `category(${name}) = ${category}`);
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
