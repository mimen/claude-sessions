import { Database } from "bun:sqlite";

/**
 * The Catalogue: durable, user-authored session metadata that the Index cache cannot hold
 * (it gets dropped on schema bumps). Stored in its own SQLite file (see paths.CATALOGUE_PATH)
 * so the Index can be nuked/rebuilt without ever touching this.
 *
 * Migrations here are ADDITIVE ONLY — we never drop. `user_version` gates each step.
 */

export type Kind = "session" | "loop";
export type Lifecycle = "idle" | "parked" | "completed" | "archived";

export interface CatalogueRow {
  sessionId: string;
  resumeId: string | null;
  customTitle: string | null;
  kind: Kind;
  completed: boolean;
  archived: boolean;
  parkedTaskId: string | null;
  /** Event slug this session belongs to (set by the event-watch scout, or manually). */
  event: string | null;
  /** The session that spawned/owns this one (a sessionId). Children are a reverse lookup. */
  parentSessionId: string | null;
  /** The skill or slash-command backing this session (e.g. `loop-manager`, `event-watch`). */
  skill: string | null;
  /** User-assigned project/initiative label — groups otherwise-solo sessions (e.g. `ccs`). */
  project: string | null;
  /** The fleet role this session is a body of. Role definitions live in the vault
   *  (`ClaudeConfig/roles/`); the catalogue references them by name only. */
  role: string | null;
  /** The agent runtime this body runs on. Stored raw (null = unset); read the effective
   *  value through substrateOf(), which defaults to claude-code. */
  substrate: string | null;
  /** The launching identity (`CLAUDE_IDENTITY` exported by the launcher, issue 64) —
   *  which `claude-<name>` alias started this session. */
  identity: string | null;
  notes: string | null;
  updatedAt: string | null;
}

/** Effective substrate when a row doesn't say otherwise — sessions are Claude Code by default. */
export const DEFAULT_SUBSTRATE = "claude-code";

/** The effective substrate of a row (defaults unset/missing rows to claude-code). */
export function substrateOf(row: CatalogueRow | null): string {
  return row?.substrate ?? DEFAULT_SUBSTRATE;
}

const CATALOGUE_VERSION = 5;

export function openCatalogue(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  // Additive migrations only — each block guarded by version. NEVER drop user data.
  if (v < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalogue (
        session_id     TEXT PRIMARY KEY,
        resume_id      TEXT,
        custom_title   TEXT,
        kind           TEXT NOT NULL DEFAULT 'session',
        completed      INTEGER NOT NULL DEFAULT 0,
        archived       INTEGER NOT NULL DEFAULT 0,
        parked_task_id TEXT,
        notes          TEXT,
        updated_at     TEXT
      );
      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL,
        entity     TEXT NOT NULL,
        PRIMARY KEY (session_id, entity)
      );
      CREATE INDEX IF NOT EXISTS idx_tags_entity ON session_tags(entity);
    `);
  }
  if (v < 2) {
    // Additive: a first-class event slug on the session record. Nullable; no backfill.
    // Guard the ALTER on actual column presence — a still-deployed v1 binary can reset
    // user_version to 1 after we bump it, so this block can re-run; ADD COLUMN twice throws.
    if (!hasColumn(db, "catalogue", "event")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN event TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_event ON catalogue(event);");
  }
  if (v < 3) {
    // Additive: the constellation edges — a user-set parent session, and the backing skill.
    // Both nullable; no backfill. Guard each ALTER on column presence (a still-deployed older
    // binary can reset user_version, letting this block re-run; ADD COLUMN twice throws).
    if (!hasColumn(db, "catalogue", "parent_session_id")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN parent_session_id TEXT;");
    }
    if (!hasColumn(db, "catalogue", "skill")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN skill TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_parent ON catalogue(parent_session_id);");
  }
  if (v < 4) {
    // Additive: a user-assigned project/initiative label — groups otherwise-solo sessions that
    // share a repo but not a purpose (distinct from the git-derived Project). Nullable; no backfill.
    if (!hasColumn(db, "catalogue", "project")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN project TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_project ON catalogue(project);");
  }
  if (v < 5) {
    // Additive: the kernel's ontology (PRD 02, issue 13). `role` = which fleet role this session
    // is a body of (definitions in the vault, referenced by name); `substrate` = the agent runtime
    // (null reads as claude-code); `identity` = the CLAUDE_IDENTITY the launcher exported (issue
    // 64). All nullable; no backfill. Guard each ALTER on column presence as in v2-v4.
    if (!hasColumn(db, "catalogue", "role")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN role TEXT;");
    }
    if (!hasColumn(db, "catalogue", "substrate")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN substrate TEXT;");
    }
    if (!hasColumn(db, "catalogue", "identity")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN identity TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_role ON catalogue(role);");
  }
  if (v !== CATALOGUE_VERSION) db.exec(`PRAGMA user_version = ${CATALOGUE_VERSION};`);
}

/** Whether a table already has a given column (PRAGMA table_info), for idempotent ALTERs. */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Map a raw catalogue row to CatalogueRow — the ONE place column decode rules live (missing
 *  columns from an older-schema source read as null, so merge can consume lagging replicas). */
export function rowFrom(r: Record<string, unknown> | null): CatalogueRow | null {
  if (!r) return null;
  return {
    sessionId: r.session_id as string,
    resumeId: (r.resume_id as string) ?? null,
    customTitle: (r.custom_title as string) ?? null,
    kind: (r.kind as Kind) ?? "session",
    completed: !!r.completed,
    archived: !!r.archived,
    parkedTaskId: (r.parked_task_id as string) ?? null,
    event: (r.event as string) ?? null,
    parentSessionId: (r.parent_session_id as string) ?? null,
    skill: (r.skill as string) ?? null,
    project: (r.project as string) ?? null,
    role: (r.role as string) ?? null,
    substrate: (r.substrate as string) ?? null,
    identity: (r.identity as string) ?? null,
    notes: (r.notes as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
  };
}

/** Ensure a row exists for sessionId (no-op if present), so updates can UPDATE in place. */
function ensureRow(db: Database, sessionId: string, now: string): void {
  db.query(
    "INSERT INTO catalogue (session_id, updated_at) VALUES ($id, $now) ON CONFLICT(session_id) DO NOTHING",
  ).run({ $id: sessionId, $now: now });
}

export function getRow(db: Database, sessionId: string): CatalogueRow | null {
  return rowFrom(
    db.query("SELECT * FROM catalogue WHERE session_id = $id").get({ $id: sessionId }) as Record<
      string,
      unknown
    > | null,
  );
}

/** All catalogue rows keyed by session_id, for joining against the Index in one pass. */
export function getAll(db: Database): Map<string, CatalogueRow> {
  const rows = db.query("SELECT * FROM catalogue").all() as Record<string, unknown>[];
  const map = new Map<string, CatalogueRow>();
  for (const r of rows) {
    const row = rowFrom(r);
    if (row) map.set(row.sessionId, row);
  }
  return map;
}

/** Pure: lifecycle from a row (precedence archived > completed > parked > idle). */
export function lifecycleOf(row: CatalogueRow | null): Lifecycle {
  if (!row) return "idle";
  if (row.archived) return "archived";
  if (row.completed) return "completed";
  if (row.parkedTaskId) return "parked";
  return "idle";
}

// ---- mutations (all stamp updated_at; all upsert the row) ----

function set(db: Database, sessionId: string, col: string, value: unknown, now: string): void {
  ensureRow(db, sessionId, now);
  db.query(`UPDATE catalogue SET ${col} = $v, updated_at = $now WHERE session_id = $id`).run({
    $v: value as never,
    $now: now,
    $id: sessionId,
  });
}

export function setCustomTitle(db: Database, sessionId: string, title: string | null, now: string): void {
  set(db, sessionId, "custom_title", title, now);
}
export function setKind(db: Database, sessionId: string, kind: Kind, now: string): void {
  set(db, sessionId, "kind", kind, now);
}
export function setCompleted(db: Database, sessionId: string, completed: boolean, now: string): void {
  set(db, sessionId, "completed", completed ? 1 : 0, now);
}
export function setArchived(db: Database, sessionId: string, archived: boolean, now: string): void {
  set(db, sessionId, "archived", archived ? 1 : 0, now);
}
export function setParked(db: Database, sessionId: string, taskId: string | null, now: string): void {
  set(db, sessionId, "parked_task_id", taskId, now);
}
export function setResumeId(db: Database, sessionId: string, resumeId: string, now: string): void {
  set(db, sessionId, "resume_id", resumeId, now);
}
export function setEvent(db: Database, sessionId: string, event: string | null, now: string): void {
  set(db, sessionId, "event", event, now);
}
export function setParent(db: Database, sessionId: string, parentId: string | null, now: string): void {
  set(db, sessionId, "parent_session_id", parentId, now);
}
export function setSkill(db: Database, sessionId: string, skill: string | null, now: string): void {
  set(db, sessionId, "skill", skill, now);
}
export function setProject(db: Database, sessionId: string, project: string | null, now: string): void {
  set(db, sessionId, "project", project, now);
}
export function setRole(db: Database, sessionId: string, role: string | null, now: string): void {
  set(db, sessionId, "role", role, now);
}
export function setSubstrate(db: Database, sessionId: string, substrate: string | null, now: string): void {
  // The default is STORED AS UNSET — normalize here so `claude-code` and NULL never coexist
  // as two representations of the same substrate.
  set(db, sessionId, "substrate", substrate === DEFAULT_SUBSTRATE ? null : substrate, now);
}
export function setIdentity(db: Database, sessionId: string, identity: string | null, now: string): void {
  set(db, sessionId, "identity", identity, now);
}

/** Reverse lookup: which sessions are assigned to this event slug. */
export function sessionsForEvent(db: Database, event: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE event = $e").all({ $e: event }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: the bodies of a role (unordered — lineage ordering joins the Index). */
export function sessionsForRole(db: Database, role: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE role = $r").all({ $r: role }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: the sessions whose parent is this one (its children in the constellation). */
export function childrenOf(db: Database, parentId: string): string[] {
  return (
    db
      .query("SELECT session_id FROM catalogue WHERE parent_session_id = $p ORDER BY session_id")
      .all({ $p: parentId }) as { session_id: string }[]
  ).map((r) => r.session_id);
}

/** Every (childId, parentId) edge in the catalogue, for building the constellation in one pass. */
export function parentEdges(db: Database): Array<{ sessionId: string; parentId: string }> {
  return (
    db
      .query(
        "SELECT session_id AS sessionId, parent_session_id AS parentId FROM catalogue WHERE parent_session_id IS NOT NULL",
      )
      .all() as Array<{ sessionId: string; parentId: string }>
  );
}

// ---- tags ----

export function addTag(db: Database, sessionId: string, entity: string): void {
  db.query(
    "INSERT INTO session_tags (session_id, entity) VALUES ($id, $e) ON CONFLICT DO NOTHING",
  ).run({ $id: sessionId, $e: entity });
}
export function removeTag(db: Database, sessionId: string, entity: string): void {
  db.query("DELETE FROM session_tags WHERE session_id = $id AND entity = $e").run({
    $id: sessionId,
    $e: entity,
  });
}
export function getTags(db: Database, sessionId: string): string[] {
  return (
    db.query("SELECT entity FROM session_tags WHERE session_id = $id ORDER BY entity").all({
      $id: sessionId,
    }) as { entity: string }[]
  ).map((r) => r.entity);
}
/** Reverse lookup: which sessions are tagged with this entity. */
export function sessionsForEntity(db: Database, entity: string): string[] {
  return (
    db.query("SELECT session_id FROM session_tags WHERE entity = $e").all({ $e: entity }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}
