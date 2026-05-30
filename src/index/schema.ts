import { Database } from "bun:sqlite";

/** Bump when the schema changes; the Index is a pure cache, so we just rebuild on mismatch. */
export const SCHEMA_VERSION = 3;

/**
 * Open (creating if needed) the Index and ensure its schema is current. If the on-disk
 * schema version differs, drop everything and recreate — nothing is lost, the Index is
 * fully reconstructable from the Store.
 */
export function openIndex(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current !== SCHEMA_VERSION) {
    dropAll(db);
    createSchema(db);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
  return db;
}

function dropAll(db: Database): void {
  db.exec("DROP TABLE IF EXISTS sessions_fts;");
  db.exec("DROP TABLE IF EXISTS sessions;");
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE sessions (
      session_id      TEXT PRIMARY KEY,
      host            TEXT NOT NULL,
      path            TEXT NOT NULL,
      cwd             TEXT,
      project_root    TEXT NOT NULL,
      project_name    TEXT NOT NULL,
      branch          TEXT,
      version         TEXT,
      first_ts        TEXT,
      last_ts         TEXT,
      msg_count       INTEGER NOT NULL DEFAULT 0,
      file_mtime      REAL NOT NULL,
      file_size       INTEGER NOT NULL,
      native_title    TEXT,
      codex_title     TEXT,
      fallback_label  TEXT NOT NULL,
      title_msg_count INTEGER,
      title_attempts  INTEGER NOT NULL DEFAULT 0,
      skeleton        TEXT NOT NULL DEFAULT '',
      is_subagent     INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT
    );
  `);
  db.exec("CREATE INDEX idx_sessions_last_ts ON sessions(last_ts DESC);");
  db.exec("CREATE INDEX idx_sessions_subagent ON sessions(is_subagent);");
  db.exec("CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);");
  db.exec("CREATE INDEX idx_sessions_project ON sessions(project_root);");
  // Standalone FTS over the resolved title + skeleton; kept in sync on upsert.
  db.exec(`
    CREATE VIRTUAL TABLE sessions_fts USING fts5(
      session_id UNINDEXED,
      title,
      skeleton
    );
  `);
}
