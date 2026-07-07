import { Database } from "bun:sqlite";
import type { SkillRecord, Ecosystem } from "./scan.ts";

/**
 * Skills DB: one file, two lifetimes.
 * - Cache tables (skills, usage_files, usage_counts) are rebuildable — dropped on version bump.
 * - The tags table is durable user-authored organization (like the Catalogue) and is NEVER dropped.
 */
export const SKILLS_CACHE_VERSION = 2;

export function openSkillsDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      skill_name TEXT NOT NULL,
      tag        TEXT NOT NULL,
      PRIMARY KEY (skill_name, tag)
    );
  `);
  // Category: single curated bucket per logical skill (all copies share it). Durable like tags.
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      skill_name TEXT NOT NULL PRIMARY KEY,
      category   TEXT NOT NULL
    );
  `);

  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== SKILLS_CACHE_VERSION) {
    db.exec("DROP TABLE IF EXISTS skills;");
    db.exec("DROP TABLE IF EXISTS usage_files;");
    db.exec("DROP TABLE IF EXISTS usage_counts;");
    db.exec(`PRAGMA user_version = ${SKILLS_CACHE_VERSION};`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      name        TEXT NOT NULL,
      path        TEXT NOT NULL PRIMARY KEY,
      real_path   TEXT NOT NULL,
      ecosystem   TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      aliases     TEXT NOT NULL DEFAULT '[]',
      mtime_ms    REAL NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL DEFAULT ''
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_files (
      path  TEXT NOT NULL PRIMARY KEY,
      size  INTEGER NOT NULL,
      mtime REAL NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_counts (
      file    TEXT NOT NULL,
      skill   TEXT NOT NULL,
      kind    TEXT NOT NULL,
      count   INTEGER NOT NULL,
      last_ts TEXT NOT NULL,
      PRIMARY KEY (file, skill, kind)
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_usage_skill ON usage_counts(skill);");
  return db;
}

/**
 * Serialize writers on the skills DB. The TUI panel remounts on every Tab back into skills
 * mode and its mount effect starts a usage-mine; overlapping runs on one connection interleave
 * transactions and throw (crashing Ink via unhandled rejection). All async write flows go
 * through this promise-chain mutex instead.
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function serializeSkillsWrite<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = writeChain.then(fn);
  writeChain = next.catch(() => {});
  return next;
}

/** Replace the whole cached registry with a fresh scan result. */
export function saveSkills(db: Database, records: SkillRecord[]): void {
  const insert = db.prepare(
    "INSERT OR REPLACE INTO skills (name, path, real_path, ecosystem, description, aliases, mtime_ms, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const tx = db.transaction((rows: SkillRecord[]) => {
    db.exec("DELETE FROM skills;");
    for (const r of rows) {
      insert.run(r.name, r.path, r.realPath, r.ecosystem, r.description, JSON.stringify(r.aliases), r.mtimeMs, r.contentHash);
    }
  });
  tx(records);
}

/** Remove one physical record (after an archive/move); usage + tags stay (name-keyed). */
export function removeSkillPath(db: Database, path: string): void {
  db.prepare("DELETE FROM skills WHERE path = ?").run(path);
}

export function loadSkills(db: Database): SkillRecord[] {
  const rows = db.query("SELECT * FROM skills").all() as Array<{
    name: string;
    path: string;
    real_path: string;
    ecosystem: string;
    description: string;
    aliases: string;
    mtime_ms: number;
    content_hash: string;
  }>;
  return rows.map((r) => ({
    name: r.name,
    path: r.path,
    realPath: r.real_path,
    ecosystem: r.ecosystem as Ecosystem,
    description: r.description,
    aliases: JSON.parse(r.aliases) as string[],
    mtimeMs: r.mtime_ms,
    contentHash: r.content_hash,
  }));
}

export interface UsageTotals {
  invocations: number;
  commands: number;
  reads: number;
  lastUsed: string;
}

/** Aggregate usage across all mined transcript files, keyed by skill slug. */
export function usageTotals(db: Database): Map<string, UsageTotals> {
  const rows = db
    .query("SELECT skill, kind, SUM(count) AS n, MAX(last_ts) AS last FROM usage_counts GROUP BY skill, kind")
    .all() as Array<{ skill: string; kind: string; n: number; last: string }>;
  const out = new Map<string, UsageTotals>();
  for (const r of rows) {
    const t = out.get(r.skill) ?? { invocations: 0, commands: 0, reads: 0, lastUsed: "" };
    if (r.kind === "invoke") t.invocations += r.n;
    else if (r.kind === "command") t.commands += r.n;
    else if (r.kind === "read") t.reads += r.n;
    if (r.last > t.lastUsed) t.lastUsed = r.last;
    out.set(r.skill, t);
  }
  return out;
}

export function tagsFor(db: Database): Map<string, string[]> {
  const rows = db.query("SELECT skill_name, tag FROM tags ORDER BY tag").all() as Array<{
    skill_name: string;
    tag: string;
  }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.skill_name) ?? [];
    list.push(r.tag);
    out.set(r.skill_name, list);
  }
  return out;
}

export function addTag(db: Database, skillName: string, tag: string): void {
  db.prepare("INSERT OR IGNORE INTO tags (skill_name, tag) VALUES (?, ?)").run(skillName, tag);
}

export function removeTag(db: Database, skillName: string, tag: string): void {
  db.prepare("DELETE FROM tags WHERE skill_name = ? AND tag = ?").run(skillName, tag);
}

export function categoriesFor(db: Database): Map<string, string> {
  const rows = db.query("SELECT skill_name, category FROM categories").all() as Array<{
    skill_name: string;
    category: string;
  }>;
  return new Map(rows.map((r) => [r.skill_name, r.category]));
}

/** Set (or clear with null) the single curated category for a logical skill name. */
export function setCategory(db: Database, skillName: string, category: string | null): void {
  if (category === null || category === "") {
    db.prepare("DELETE FROM categories WHERE skill_name = ?").run(skillName);
  } else {
    db.prepare("INSERT OR REPLACE INTO categories (skill_name, category) VALUES (?, ?)").run(skillName, category);
  }
}

/** Per-transcript-file usage for one skill — the raw material for a used-by-project breakdown. */
export function usageFilesFor(db: Database, skillName: string): Array<{ file: string; count: number; lastTs: string }> {
  return (
    db
      .query("SELECT file, SUM(count) AS count, MAX(last_ts) AS lastTs FROM usage_counts WHERE skill = ? GROUP BY file")
      .all(skillName) as Array<{ file: string; count: number; lastTs: string }>
  );
}
