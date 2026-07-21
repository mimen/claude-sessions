import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reindexStore, search, sessionById } from "./index.ts";
import { openIndex, SCHEMA_VERSION } from "./schema.ts";

function createPreChangeIndex(dbPath: string, userVersion = 7): void {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, host TEXT NOT NULL, path TEXT NOT NULL, cwd TEXT,
      project_root TEXT NOT NULL, project_name TEXT NOT NULL, branch TEXT, version TEXT,
      first_ts TEXT, last_ts TEXT, msg_count INTEGER NOT NULL DEFAULT 0,
      file_mtime REAL NOT NULL, file_size INTEGER NOT NULL, native_title TEXT,
      codex_title TEXT, fallback_label TEXT NOT NULL, title_msg_count INTEGER,
      title_attempts INTEGER NOT NULL DEFAULT 0, skeleton TEXT NOT NULL DEFAULT '',
      is_subagent INTEGER NOT NULL DEFAULT 0, parent_session_id TEXT,
      resume_id TEXT NOT NULL DEFAULT '', cost_usd REAL NOT NULL DEFAULT 0,
      tok_input INTEGER NOT NULL DEFAULT 0, tok_output INTEGER NOT NULL DEFAULT 0,
      tok_cache_read INTEGER NOT NULL DEFAULT 0, tok_cache_write INTEGER NOT NULL DEFAULT 0,
      cost_by_model TEXT NOT NULL DEFAULT '{}', user_turns INTEGER NOT NULL DEFAULT 0,
      tick_interval_sec INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE sessions_fts USING fts5(session_id UNINDEXED, title, skeleton);
    PRAGMA user_version = ${userVersion};
  `);
  db.query(`INSERT INTO sessions (
    session_id, host, path, cwd, project_root, project_name, fallback_label,
    msg_count, file_mtime, file_size, codex_title, skeleton, resume_id
  ) VALUES ('legacy', 'host', '/old.jsonl', '/old', '/old', 'old', 'old fallback',
    1, 1, 1, 'preserved generated title', 'old skeleton', 'resume-legacy')`).run();
  db.query("INSERT INTO sessions_fts (session_id, title, skeleton) VALUES ('legacy', 'preserved generated title', 'old skeleton')").run();
  db.close();
}

test("openIndex preserves complete v7 rows while adding duplicate diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-migration-"));
  const dbPath = join(root, "index.db");
  const transcript = join(root, "legacy.jsonl");
  createPreChangeIndex(dbPath);
  writeFileSync(transcript, `${JSON.stringify({ type: "user", cwd: root, message: { content: "updated" } })}\n`);

  const db = openIndex(dbPath);
  try {
    const columns = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "shadow_paths")).toBe(true);
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(sessionById(db, "legacy")?.shadowPaths).toEqual([]);
    expect(db.query("SELECT resume_id, codex_title FROM sessions WHERE session_id = 'legacy'").get()).toEqual({
      resume_id: "resume-legacy",
      codex_title: "preserved generated title",
    });

    const stats = await reindexStore(db, [{
      path: transcript,
      sessionId: "legacy",
      sizeBytes: 2,
      mtimeMs: 2,
    }], "host");
    expect(stats.parsed).toBe(1);
    const row = db.query("SELECT codex_title, resume_id, shadow_paths FROM sessions WHERE session_id = 'legacy'").get();
    expect(row).toEqual({
      codex_title: "preserved generated title",
      resume_id: "legacy",
      shadow_paths: "[]",
    });
    expect(search(db, "preserved generated").map((entry) => entry.sessionId)).toEqual(["legacy"]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("openIndex rebuilds incompatible pre-v6 schemas instead of stamping them as v8", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-pre-v6-"));
  const dbPath = join(root, "index.db");
  const legacy = new Database(dbPath, { create: true });
  legacy.exec(`
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, path TEXT NOT NULL);
    INSERT INTO sessions (session_id, path) VALUES ('v5-row', '/old.jsonl');
    PRAGMA user_version = 5;
  `);
  legacy.close();

  const db = openIndex(dbPath);
  try {
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    const columns = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "host")).toBe(true);
    expect(columns.some((column) => column.name === "shadow_paths")).toBe(true);
    expect(db.query("SELECT session_id FROM sessions WHERE session_id = 'v5-row'").get()).toBeNull();
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions_fts'").get()).not.toBeNull();
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("openIndex invalidates structurally compatible v6 stale-cost rows before reindex", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-v6-"));
  const dbPath = join(root, "index.db");
  const transcript = join(root, "legacy.jsonl");
  createPreChangeIndex(dbPath, 6);
  const stale = new Database(dbPath);
  stale.query("UPDATE sessions SET cost_usd = 999 WHERE session_id = 'legacy'").run();
  stale.close();
  writeFileSync(transcript, `${JSON.stringify({ type: "user", cwd: root, message: { content: "fresh" } })}
`);

  const db = openIndex(dbPath);
  try {
    expect(db.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    const stats = await reindexStore(db, [{
      path: transcript,
      sessionId: "legacy",
      sizeBytes: 2,
      mtimeMs: 2,
    }], "host");
    expect(stats.parsed).toBe(1);
    expect(db.query("SELECT cost_usd FROM sessions WHERE session_id = 'legacy'").get()).toEqual({ cost_usd: 0 });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("openIndex is idempotent after a serialized v7 migration", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-lock-"));
  const dbPath = join(root, "index.db");
  createPreChangeIndex(dbPath);
  const first = openIndex(dbPath);
  const second = openIndex(dbPath);
  try {
    expect(first.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
    expect(second.query("SELECT session_id FROM sessions WHERE session_id = 'legacy'").get()).toEqual({ session_id: "legacy" });
  } finally {
    second.close();
    first.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("openIndex refuses a future compatible schema without changing it", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-index-future-"));
  const dbPath = join(root, "index.db");
  createPreChangeIndex(dbPath, SCHEMA_VERSION + 1);

  expect(() => openIndex(dbPath)).toThrow(`index schema version ${SCHEMA_VERSION + 1} is newer than supported version ${SCHEMA_VERSION}`);

  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION + 1 });
    const columns = db.query("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "shadow_paths")).toBe(false);
    expect(db.query("SELECT session_id FROM sessions WHERE session_id = 'legacy'").get()).toEqual({ session_id: "legacy" });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
