import { homedir } from "node:os";
import type { SkillRecord } from "./scan.ts";
import type { UsageTotals } from "./db.ts";

/**
 * Pure view logic for the skills TUI: home labels, activity buckets, drift detection,
 * search filtering, and the section/item builder for every view mode.
 */

export type SkillsView = "home" | "name" | "category" | "activity" | "flat";
export const SKILLS_VIEW_CYCLE: SkillsView[] = ["home", "name", "category", "activity", "flat"];

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

export interface BuildCtx {
  view: SkillsView;
  sort: SkillsSort;
  collapsed: ReadonlySet<string>;
  nowMs: number;
}

/** Section-ordering: biggest first for home/name/category; fixed order for activity. */
export function buildSkillItems(rows: SkillRow[], ctx: BuildCtx): SkillItem[] {
  if (ctx.view === "flat") return sortSkillRows(rows, ctx.sort).map((row) => ({ kind: "skill", row }));

  const keyOf = (r: SkillRow): string =>
    ctx.view === "home"
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
