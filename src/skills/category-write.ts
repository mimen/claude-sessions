import { readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { SkillRecord, Ecosystem } from "./scan.ts";
import { setCategory } from "./db.ts";

/**
 * Category writes go to the SKILL.md frontmatter when we own the file (claude-user /
 * claude-project ecosystems) — frontmatter is canonical and the db would be masked anyway.
 * Foreign ecosystems (plugins, other tools) fall back to the db table.
 */
export interface CategoryWriteResult {
  mode: "frontmatter" | "db";
  /** SKILL.md path when mode=frontmatter. */
  path?: string;
}

const EDITABLE = new Set<Ecosystem>(["claude-user", "claude-project"]);

/** Pick the record whose file we should edit: prefer the global install over project copies. */
export function pickWritableRecord(records: SkillRecord[], name: string): SkillRecord | null {
  const candidates = records.filter((r) => r.name === name && EDITABLE.has(r.ecosystem));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.ecosystem === "claude-user" ? -1 : 0) - (b.ecosystem === "claude-user" ? -1 : 0));
  const chosen = candidates[0]!;
  try {
    accessSync(join(chosen.realPath, "SKILL.md"), constants.W_OK);
    return chosen;
  } catch {
    return null;
  }
}

/** Insert, replace, or remove the `category:` line in a SKILL.md's frontmatter. Pure; exported for tests. */
export function rewriteFrontmatterCategory(text: string, category: string | null): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const fm = text.slice(0, end);
  const lineRe = /\ncategory:[^\n]*/;
  if (lineRe.test(fm)) {
    const newFm = category ? fm.replace(lineRe, `\ncategory: ${category}`) : fm.replace(lineRe, "");
    return newFm + text.slice(end);
  }
  if (!category) return text; // nothing to clear
  return fm + `\ncategory: ${category}` + text.slice(end);
}

/**
 * Set (or clear with null) a skill's category in the right place. Mutates the matching
 * in-memory records' `category` so callers can refresh without a rescan.
 */
export function writeCategory(
  db: Database,
  records: SkillRecord[],
  name: string,
  category: string | null,
): CategoryWriteResult {
  const target = pickWritableRecord(records, name);
  if (target) {
    const skillMd = join(target.realPath, "SKILL.md");
    const text = readFileSync(skillMd, "utf8");
    const next = rewriteFrontmatterCategory(text, category);
    if (next !== null) {
      if (next !== text) writeFileSync(skillMd, next);
      for (const r of records) if (r.name === name && EDITABLE.has(r.ecosystem)) r.category = category;
      // Drop any db row so it can never mask a future frontmatter edit.
      setCategory(db, name, null);
      return { mode: "frontmatter", path: skillMd };
    }
  }
  setCategory(db, name, category);
  return { mode: "db" };
}

/**
 * Hygiene after a rescan: remove db rows shadowed by frontmatter, and rows whose skill
 * no longer exists anywhere on disk. Returns how many rows were dropped.
 */
export function pruneCategoryRows(db: Database, records: SkillRecord[]): number {
  const live = new Set(records.map((r) => r.name));
  const fmNames = new Set(records.filter((r) => r.category).map((r) => r.name));
  const rows = db.query("SELECT skill_name FROM categories").all() as Array<{ skill_name: string }>;
  let dropped = 0;
  for (const { skill_name } of rows) {
    if (!live.has(skill_name) || fmNames.has(skill_name)) {
      db.prepare("DELETE FROM categories WHERE skill_name = ?").run(skill_name);
      dropped++;
    }
  }
  return dropped;
}
