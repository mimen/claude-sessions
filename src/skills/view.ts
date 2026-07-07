import { homedir } from "node:os";
import type { SkillRecord } from "./scan.ts";
import type { UsageTotals } from "./db.ts";

/**
 * Pure view logic for the skills TUI: home labels, activity buckets, drift detection,
 * search filtering, and the section/item builder for every view mode.
 */

export type SkillsView = "home" | "name" | "category" | "activity" | "flat" | "access";
export const SKILLS_VIEW_CYCLE: SkillsView[] = ["home", "name", "category", "activity", "flat"];
/** Inside a context lens the extra "access" view (grouped by HOW a skill loads) leads the cycle. */
export const CONTEXT_VIEW_CYCLE: SkillsView[] = ["access", "home", "name", "category", "activity", "flat"];

/**
 * Stable color per category so the CATEGORY column scans at a glance. Fixed map for the
 * curated taxonomy; unknown categories hash into the palette so new ones stay colored.
 */
const CATEGORY_COLORS: Record<string, string> = {
  events: "#e0876a", // coral — AUF event ops
  label: "#d9a0e8", // lilac — AUF Records
  music: "#86b3ff", // blue
  comms: "greenBright",
  finance: "#cbb079", // gold
  pkm: "cyan",
  loops: "magenta",
  dev: "yellow",
  infra: "#9aa3b2", // grey — plumbing
  services: "green",
};
const CATEGORY_FALLBACK = ["blueBright", "magentaBright", "cyanBright", "yellowBright", "redBright"];

export function categoryColor(category: string | null): string | undefined {
  if (!category) return undefined;
  const fixed = CATEGORY_COLORS[category];
  if (fixed) return fixed;
  let h = 0;
  for (const ch of category) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CATEGORY_FALLBACK[h % CATEGORY_FALLBACK.length];
}

export type SkillsSort = "recent" | "usage" | "name";
export const SKILLS_SORT_CYCLE: SkillsSort[] = ["recent", "usage", "name"];

/** One physical skill directory, fully joined for display. */
export interface SkillRow {
  rec: SkillRecord;
  /** Human "where it lives": global, a repo/workspace name, plugin:<mkt>, codex, … */
  home: string;
  category: string | null;
  tags: string[];
  /** Usage is name-keyed, so all copies of a name share it. */
  usage: UsageTotals | null;
  /** True when same-name copies elsewhere have a different SKILL.md hash. */
  drift: boolean;
}

export type SkillItem =
  | { kind: "section"; key: string; name: string; count: number; collapsed: boolean }
  | { kind: "skill"; row: SkillRow };

const ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

/** Human label for where a skill lives. Pure; exported for tests. */
export function homeOf(path: string, home: string = homedir()): string {
  const p = path.startsWith(home) ? "~" + path.slice(home.length) : path;
  if (p.includes("/_archive/") || p.includes("/deprecated/")) return "archive";
  if (p.startsWith("~/Downloads/")) return "downloads";
  const plugin = p.match(/^~\/\.claude\/plugins\/(?:marketplaces|cache)\/([^/]+)\//);
  if (plugin) return `plugin:${plugin[1]}`;
  if (p.startsWith("~/.claude/skills/")) return "global";
  if (p.includes("/ClaudeConfig/skills/")) return "global";
  if (p.startsWith("~/.agents/")) return "agents";
  if (p.startsWith("~/.codex/")) return "codex";
  if (p.startsWith("~/.cursor/")) return "cursor";
  if (p.startsWith("~/.hermes/")) return "hermes";
  const workspace = p.match(/\/Workspaces\/([^/]+)\/\.claude\/skills\//);
  if (workspace) return workspace[1]!;
  // Repo-local: the directory that owns the .claude/ (or bare skills/) dir.
  const repo = p.match(/([^/]+)\/\.(?:claude|agents)\/(?:skills|commands)\//) ?? p.match(/([^/]+)\/skills\/[^/]+$/);
  if (repo) return repo[1]!;
  return "other";
}

export type Activity = "active" | "dormant" | "unobserved";

export function activityOf(usage: UsageTotals | null, nowMs: number): Activity {
  if (!usage || !usage.lastUsed) return "unobserved";
  const ts = Date.parse(usage.lastUsed);
  if (Number.isNaN(ts)) return "unobserved";
  return nowMs - ts <= ACTIVE_MS ? "active" : "dormant";
}

/**
 * A context = the harness (and for Claude Code, the starting directory) a session runs in.
 * Access rules differ per harness:
 * - claude: ~/.claude/skills always; installed plugins always; project .claude/skills from the
 *   cwd and every ancestor at launch; nested .claude/skills below cwd lazily on file-touch.
 * - codex: ~/.codex/skills (its .system set + the symlink bridge into Claude skills).
 * - hermes: ~/.hermes/skills installed set; optional-skills exist but are not enabled.
 * - cursor/agents: their own flat dirs.
 */
export type SkillContext =
  | { kind: "all" }
  | { kind: "claude"; cwd: string }
  | { kind: "codex" }
  | { kind: "hermes" }
  | { kind: "cursor" }
  | { kind: "agents" };

export function contextLabel(ctx: SkillContext, home: string = homedir()): string {
  if (ctx.kind === "claude") {
    const cwd = ctx.cwd === home ? "~" : ctx.cwd.startsWith(home) ? "~" + ctx.cwd.slice(home.length) : ctx.cwd;
    return `claude @ ${cwd}`;
  }
  return ctx.kind;
}

/**
 * How this skill is accessible in the given context, or null if it isn't.
 * Checks every address of the record (primary path + symlink aliases) — the codex bridge
 * symlinks make Claude skills codex-accessible, and that's only visible via aliases.
 */
export function accessIn(rec: SkillRecord, ctx: SkillContext, home: string = homedir()): string | null {
  if (ctx.kind === "all") return "—";
  const addrs = [rec.path, ...rec.aliases];
  const under = (prefix: string): string | undefined => addrs.find((a) => a.startsWith(prefix));

  if (ctx.kind === "claude") {
    if (under(`${home}/.claude/skills/`)) return "global";
    if (rec.ecosystem === "plugin") return "plugin";
    for (const a of addrs) {
      const m = a.match(/^(.*)\/\.claude\/skills\//);
      if (!m) continue;
      const owner = m[1]!;
      const cwd = ctx.cwd.endsWith("/") ? ctx.cwd.slice(0, -1) : ctx.cwd;
      if (cwd === owner || cwd.startsWith(owner + "/")) return "project (at launch)";
      if (owner.startsWith(cwd + "/")) return "nested (on file-touch)";
    }
    return null;
  }
  if (ctx.kind === "codex") {
    const hit = under(`${home}/.codex/skills/`);
    if (!hit) return null;
    return hit.includes("/.system/") ? "system" : "bridged symlink";
  }
  if (ctx.kind === "hermes") {
    if (under(`${home}/.hermes/skills/`)) return "installed";
    if (under(`${home}/.hermes/hermes-agent/optional-skills/`)) return "optional (not enabled)";
    return null;
  }
  if (ctx.kind === "cursor") return under(`${home}/.cursor/`) ? "installed" : null;
  return under(`${home}/.agents/skills/`) ? "standard dir" : null;
}

/**
 * Exact-content shadow copies: same (name, ecosystem, SKILL.md hash) appearing at multiple
 * paths — e.g. a tool's repo clone AND its installed copy (Hermes ships both). Keeps the
 * shortest path as canonical and returns the rest for hiding.
 */
export function shadowDuplicatePaths(records: readonly SkillRecord[]): Set<string> {
  const groups = new Map<string, SkillRecord[]>();
  for (const r of records) {
    if (!r.contentHash) continue;
    const key = `${r.name}\x00${r.ecosystem}\x00${r.contentHash}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const hidden = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    for (const r of sorted.slice(1)) hidden.add(r.path);
  }
  return hidden;
}

/** Names whose copies have diverged: >1 distinct non-empty SKILL.md hash. */
export function driftedNames(records: readonly SkillRecord[]): Set<string> {
  const hashes = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.contentHash) continue;
    (hashes.get(r.name) ?? hashes.set(r.name, new Set()).get(r.name)!).add(r.contentHash);
  }
  return new Set([...hashes.entries()].filter(([, h]) => h.size > 1).map(([n]) => n));
}

/**
 * Search: plain terms fuzzy-match name/description/path (case-insensitive substring per term);
 * `#term` matches category or tags exactly.
 */
export function matchesQuery(row: SkillRow, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${row.rec.name} ${row.rec.description} ${row.rec.path}`.toLowerCase();
  for (const term of terms) {
    if (term.startsWith("#")) {
      const want = term.slice(1);
      const has = (row.category ?? "").toLowerCase() === want || row.tags.some((t) => t.toLowerCase() === want);
      if (!has) return false;
    } else if (!haystack.includes(term)) {
      return false;
    }
  }
  return true;
}

function usageTotal(u: UsageTotals | null): number {
  return u ? u.invocations + u.commands + u.reads : 0;
}

export function sortSkillRows(rows: SkillRow[], sort: SkillsSort): SkillRow[] {
  const sorted = [...rows];
  if (sort === "name") sorted.sort((a, b) => a.rec.name.localeCompare(b.rec.name));
  else if (sort === "usage") sorted.sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage) || a.rec.name.localeCompare(b.rec.name));
  else
    sorted.sort(
      (a, b) => (b.usage?.lastUsed ?? "").localeCompare(a.usage?.lastUsed ?? "") || a.rec.name.localeCompare(b.rec.name),
    );
  return sorted;
}

/** Fixed section order inside a context lens — launch-time access first, lazier access after. */
const ACCESS_ORDER = [
  "global",
  "plugin",
  "project (at launch)",
  "nested (on file-touch)",
  "system",
  "bridged symlink",
  "installed",
  "optional (not enabled)",
  "standard dir",
];

/** Group rows by HOW they're accessible in the active context (rows must be pre-filtered). */
export function buildContextItems(
  rows: Array<{ row: SkillRow; access: string }>,
  sort: SkillsSort,
  collapsed: ReadonlySet<string>,
): SkillItem[] {
  const buckets = new Map<string, SkillRow[]>();
  for (const { row, access } of rows) {
    (buckets.get(access) ?? buckets.set(access, []).get(access)!).push(row);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    const ia = ACCESS_ORDER.indexOf(a);
    const ib = ACCESS_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const items: SkillItem[] = [];
  for (const key of keys) {
    const group = buckets.get(key)!;
    const isCollapsed = collapsed.has(key);
    items.push({ kind: "section", key, name: key.toUpperCase(), count: group.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const row of sortSkillRows(group, sort)) items.push({ kind: "skill", row });
  }
  return items;
}

export interface BuildCtx {
  view: SkillsView;
  sort: SkillsSort;
  collapsed: ReadonlySet<string>;
  nowMs: number;
}

/** Section-ordering: biggest first for home/name/category; fixed order for activity. */
export function buildSkillItems(rows: SkillRow[], ctx: BuildCtx): SkillItem[] {
  if (ctx.view === "flat") return sortSkillRows(rows, ctx.sort).map((row) => ({ kind: "skill", row }));

  // "access" only exists inside a context lens (buildContextItems); treat as home if it leaks here.
  const keyOf = (r: SkillRow): string =>
    ctx.view === "home" || ctx.view === "access"
      ? r.home
      : ctx.view === "name"
        ? r.rec.name
        : ctx.view === "category"
          ? r.category ?? "uncategorized"
          : activityOf(r.usage, ctx.nowMs);

  const buckets = new Map<string, SkillRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r);
  }

  let keys: string[];
  if (ctx.view === "activity") {
    keys = (["active", "dormant", "unobserved"] as const).filter((k) => buckets.has(k));
  } else if (ctx.view === "name") {
    // Only names with >1 copy are interesting as groups; singles go to a trailing UNIQUE section.
    keys = [...buckets.keys()].filter((k) => buckets.get(k)!.length > 1).sort();
    const singles = [...buckets.entries()].filter(([, v]) => v.length === 1).flatMap(([, v]) => v);
    if (singles.length > 0) {
      buckets.set("(unique names)", singles);
      keys.push("(unique names)");
    }
  } else {
    keys = [...buckets.keys()].sort((a, b) => buckets.get(b)!.length - buckets.get(a)!.length || a.localeCompare(b));
    // Uncategorized is the triage queue — pin it last so curated groups lead.
    if (ctx.view === "category" && keys.includes("uncategorized")) {
      keys = keys.filter((k) => k !== "uncategorized");
      keys.push("uncategorized");
    }
  }

  const items: SkillItem[] = [];
  for (const key of keys) {
    const group = buckets.get(key)!;
    const collapsed = ctx.collapsed.has(key);
    items.push({ kind: "section", key, name: key.toUpperCase(), count: group.length, collapsed });
    if (!collapsed) for (const row of sortSkillRows(group, ctx.sort)) items.push({ kind: "skill", row });
  }
  return items;
}
