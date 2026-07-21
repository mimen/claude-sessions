import { Database } from "bun:sqlite";

/** Bump when the schema changes. Index rows are rebuildable, but preserve them across additive upgrades. */
export const SCHEMA_VERSION = 8;

/**
 * Open (creating if needed) the Index and ensure its schema is current. Additive migrations
 * retain index rows so a binary upgrade never makes existing sessions disappear before reindex.
 */
export function openIndex(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  // Set before acquiring any write lock so parallel opens wait rather than immediately failing.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  // SQLite's immediate transaction serializes creation/migration across concurrent ccs processes.
  db.exec("BEGIN IMMEDIATE;");
  try {
    const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (current > SCHEMA_VERSION) {
      throw new Error(`index schema version ${current} is newer than supported version ${SCHEMA_VERSION}`);
    }
    if (!hasTable(db, "sessions")) {
      createSchema(db);
    } else if (current >= 7 && isV6OrV7Compatible(db)) {
      if (!hasColumn(db, "sessions", "shadow_paths")) {
        // v8: retain v7 observations and title cache while adding duplicate diagnostics.
        db.exec("ALTER TABLE sessions ADD COLUMN shadow_paths TEXT NOT NULL DEFAULT '[]';");
      }
    } else {
      // v6 cost accounting changed in v7, so its cache is stale even when its columns happen
      // to match. Pre-v6 shapes are also incomplete. Both are rebuildable from the Store.
      dropAll(db);
      createSchema(db);
    }
    if (current !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.exec("COMMIT;");
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch { /* no transaction remained to roll back */ }
    db.close();
    throw error;
  }
  return db;
}

function hasTable(db: Database, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $table")
    .get({ $table: table }) !== null;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .some((entry) => entry.name === column);
}

/** v6/v7 contain every reindex input column; v8 merely adds shadow_paths diagnostics. */
function isV6OrV7Compatible(db: Database): boolean {
  const required = [
    "session_id", "host", "path", "cwd", "project_root", "project_name", "branch", "version",
    "first_ts", "last_ts", "msg_count", "file_mtime", "file_size", "native_title", "codex_title",
    "fallback_label", "title_msg_count", "title_attempts", "skeleton", "is_subagent",
    "parent_session_id", "resume_id", "cost_usd", "tok_input", "tok_output", "tok_cache_read",
    "tok_cache_write", "cost_by_model", "user_turns", "tick_interval_sec",
  ];
  return hasTable(db, "sessions_fts") && required.every((column) => hasColumn(db, "sessions", column));
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
      parent_session_id TEXT,
      resume_id       TEXT NOT NULL DEFAULT '',
      cost_usd        REAL NOT NULL DEFAULT 0,
      tok_input       INTEGER NOT NULL DEFAULT 0,
      tok_output      INTEGER NOT NULL DEFAULT 0,
      tok_cache_read  INTEGER NOT NULL DEFAULT 0,
      tok_cache_write INTEGER NOT NULL DEFAULT 0,
      cost_by_model   TEXT NOT NULL DEFAULT '{}',
      user_turns      INTEGER NOT NULL DEFAULT 0,
      tick_interval_sec INTEGER NOT NULL DEFAULT 0,
      shadow_paths    TEXT NOT NULL DEFAULT '[]'
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
