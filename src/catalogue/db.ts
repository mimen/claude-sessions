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
export type PrState = "open" | "merged" | "closed";

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
  /** Neutral, opaque identity key for system-level grouping (replaces event; both exist during migration). */
  key: string | null;
  /** The session that spawned/owns this one (a sessionId). Children are a reverse lookup. */
  parentSessionId: string | null;
  /** The skill or slash-command backing this session (e.g. `loop-manager`, `event-watch`). */
  skill: string | null;
  /** User-assigned project/initiative label — groups otherwise-solo sessions (e.g. `ccs`). */
  project: string | null;
  /** Operation-level grouping (e.g. `pr-watch`) — sits between constellation and session. */
  system: string | null;
  /** Work-tracker id (e.g. a GUS W-number) this session is working — a structured,
   * stable identification layer (ADR-0013). Set when work starts, survives the whole
   * lifecycle, never renamed; an extra axis alongside pr_* (and better than the opaque
   * `key` for pr-watch). The FLEET ORCHESTRATOR owns what it means / membership; ccs
   * just stores it. Nullable (orphan PR = no ticket). */
  gusWork: string | null;
  /** Reference to the epic ENTITY this session's work belongs to (a FK into the
   * `epics` table, which holds the epic's name + url). A session points at one epic;
   * the name/url live once on the entity, not copied per session. Set by the fleet
   * orchestrator from its W->epic resolution. Nullable. */
  epicId: string | null;
  /** Free-form, PER-SYSTEM current activity (pr-watch: building/validating/reviewing/
   * blocked; other systems define their own). Distinct from generic `lifecycle`. */
  phase: string | null;
  notes: string | null;
  updatedAt: string | null;
  /** PR facts sensed from the session's cwd git worktree (VCS-intrinsic only). */
  prNumber: number | null;
  prRepo: string | null;
  prBranch: string | null;
  prState: PrState | null;
  prHeadSha: string | null;
}

export interface PrFacts {
  prNumber: number;
  prRepo: string;
  prBranch: string;
  prState: PrState;
  prHeadSha: string;
}

const CATALOGUE_VERSION = 11;

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
    // Additive: operation-level grouping (e.g. `pr-watch`) — sits between constellation and session.
    // Nullable; no backfill.
    if (!hasColumn(db, "catalogue", "system")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN system TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_system ON catalogue(system);");
  }
  if (v < 6) {
    // Additive: PR facts sensed from the session's cwd git worktree (VCS-intrinsic only).
    // All nullable; no backfill. Guard each ALTER on column presence (older binary can reset version).
    if (!hasColumn(db, "catalogue", "pr_number")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN pr_number INTEGER;");
    }
    if (!hasColumn(db, "catalogue", "pr_repo")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN pr_repo TEXT;");
    }
    if (!hasColumn(db, "catalogue", "pr_branch")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN pr_branch TEXT;");
    }
    if (!hasColumn(db, "catalogue", "pr_state")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN pr_state TEXT;");
    }
    if (!hasColumn(db, "catalogue", "pr_head_sha")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN pr_head_sha TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_pr_number ON catalogue(pr_number);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_pr_repo ON catalogue(pr_repo);");
  }
  if (v < 7) {
    // Additive: a neutral, opaque identity key for system-level grouping (eventually replaces event).
    // Nullable; no backfill. Guard on column presence (older binary can reset version, re-run block).
    if (!hasColumn(db, "catalogue", "key")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN key TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_key ON catalogue(key);");
  }
  if (v < 8) {
    // Additive: gus_work — a work-tracker id (GUS W-number) the session is working.
    // A structured, stable identification layer (ADR-0013): set pre-PR, survives the
    // lifecycle, never renamed. Pairs with pr_* as an extra axis; the fleet orchestrator
    // owns membership/meaning, ccs just stores it. Nullable; no backfill.
    if (!hasColumn(db, "catalogue", "gus_work")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN gus_work TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_gus_work ON catalogue(gus_work);");
  }
  if (v < 9) {
    // Additive: epic as a first-class ENTITY. `epics` holds the epic's name + url ONCE;
    // a session references it by epic_id (FK). The fleet orchestrator upserts epics +
    // sets each session's epic_id from its W->epic resolution; ccs just stores it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS epics (
        epic_id    TEXT PRIMARY KEY,
        name       TEXT,
        url        TEXT,
        updated_at TEXT
      );
    `);
    if (!hasColumn(db, "catalogue", "epic_id")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN epic_id TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_epic ON catalogue(epic_id);");
  }
  if (v < 10) {
    // Additive: a short, column-friendly epic label (e.g. "Team Tokens") beside the
    // full name — for the grouping header / a narrow column.
    if (!hasColumn(db, "epics", "short_name")) {
      db.exec("ALTER TABLE epics ADD COLUMN short_name TEXT;");
    }
  }
  if (v < 11) {
    // Additive: a free-form `phase` — the session's current fine-grained activity. Unlike
    // `lifecycle` (generic across all sessions: idle/parked/completed/archived), phase is
    // PER-SYSTEM: pr-watch workers use building/validating/reviewing/blocked, event-watch
    // would use its own vocabulary. ccs stores it opaquely; each system defines its values.
    if (!hasColumn(db, "catalogue", "phase")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN phase TEXT;");
    }
  }
  if (v !== CATALOGUE_VERSION) db.exec(`PRAGMA user_version = ${CATALOGUE_VERSION};`);
}

/** Whether a table already has a given column (PRAGMA table_info), for idempotent ALTERs. */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function rowFrom(r: Record<string, unknown> | null): CatalogueRow | null {
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
    key: (r.key as string) ?? null,
    parentSessionId: (r.parent_session_id as string) ?? null,
    skill: (r.skill as string) ?? null,
    project: (r.project as string) ?? null,
    system: (r.system as string) ?? null,
    gusWork: (r.gus_work as string) ?? null,
    epicId: (r.epic_id as string) ?? null,
    phase: (r.phase as string) ?? null,
    notes: (r.notes as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
    prNumber: (r.pr_number as number) ?? null,
    prRepo: (r.pr_repo as string) ?? null,
    prBranch: (r.pr_branch as string) ?? null,
    prState: (r.pr_state as PrState) ?? null,
    prHeadSha: (r.pr_head_sha as string) ?? null,
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

/**
 * Pure: the canonical identity key (prefers `key` over `event` for expand→migrate→contract).
 * During the transition, `key` is the modern canonical field; `event` is legacy.
 * Returns `key` if set, else falls back to `event`.
 */
export function identityKeyOf(row: CatalogueRow | null): string | null {
  if (!row) return null;
  return row.key ?? row.event;
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
export function setKey(db: Database, sessionId: string, key: string | null, now: string): void {
  set(db, sessionId, "key", key, now);
}
/**
 * @deprecated Use `setKey` instead. This alias writes to `key` for backward compatibility.
 */
export function setEvent(db: Database, sessionId: string, event: string | null, now: string): void {
  setKey(db, sessionId, event, now);
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
export function setSystem(db: Database, sessionId: string, system: string | null, now: string): void {
  set(db, sessionId, "system", system, now);
}
export function setGusWork(db: Database, sessionId: string, gusWork: string | null, now: string): void {
  set(db, sessionId, "gus_work", gusWork, now);
}
export function setPhase(db: Database, sessionId: string, phase: string | null, now: string): void {
  set(db, sessionId, "phase", phase, now);
}

/** Reverse lookup: which sessions are working this GUS work item (a work-unit may span sessions). */
export function sessionsForGusWork(db: Database, gusWork: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE gus_work = $g").all({ $g: gusWork }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

// ---- Epic entity (first-class: name + url stored once, sessions reference by id) ----

export interface EpicRow {
  epicId: string;
  name: string | null;
  /** Short, column-friendly label (e.g. "Team Tokens") — for grouping headers / a narrow column. */
  shortName: string | null;
  url: string | null;
  updatedAt: string | null;
}

/** Derive a short epic label from the full name: drop the "[Team]" prefix + "FY27 " filler,
 * then take a few significant leading words. A caller-supplied short name always wins. */
export function deriveShortName(name: string | null): string | null {
  if (!name) return null;
  let s = name.replace(/^\[[^\]]+\]\s*/, "").replace(/^FY\d{2}\s+/, "").trim();
  // Cut at a natural boundary (before "&", ":", "—", or after ~3 words) for a tight label.
  s = s.split(/\s*[&:—-]\s*/)[0]!.trim();
  const words = s.split(/\s+/);
  return (words.length > 4 ? words.slice(0, 4).join(" ") : s) || null;
}

/** Upsert an epic entity (id + name + short_name + url). short_name derived if not given. */
export function upsertEpic(
  db: Database, epicId: string, name: string | null, url: string | null, now: string, shortName?: string | null,
): void {
  const short = shortName ?? deriveShortName(name);
  db.query(
    `INSERT INTO epics (epic_id, name, short_name, url, updated_at) VALUES ($id, $name, $short, $url, $now)
     ON CONFLICT(epic_id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name,
       url=excluded.url, updated_at=excluded.updated_at`,
  ).run({ $id: epicId, $name: name, $short: short, $url: url, $now: now });
}

/** Point a session at its epic entity (FK). null clears it. */
export function setSessionEpic(db: Database, sessionId: string, epicId: string | null, now: string): void {
  set(db, sessionId, "epic_id", epicId, now);
}

function epicRowFrom(r: {
  epic_id: string; name: string | null; short_name: string | null; url: string | null; updated_at: string | null;
}): EpicRow {
  return { epicId: r.epic_id, name: r.name, shortName: r.short_name, url: r.url, updatedAt: r.updated_at };
}

export function getEpic(db: Database, epicId: string): EpicRow | null {
  const r = db.query("SELECT epic_id, name, short_name, url, updated_at FROM epics WHERE epic_id = $id").get({ $id: epicId }) as
    | { epic_id: string; name: string | null; short_name: string | null; url: string | null; updated_at: string | null }
    | null;
  return r ? epicRowFrom(r) : null;
}

export function allEpics(db: Database): Map<string, EpicRow> {
  const rows = db.query("SELECT epic_id, name, short_name, url, updated_at FROM epics").all() as {
    epic_id: string; name: string | null; short_name: string | null; url: string | null; updated_at: string | null;
  }[];
  return new Map(rows.map((r) => [r.epic_id, epicRowFrom(r)]));
}

/** Reverse lookup: sessions belonging to an epic. */
export function sessionsForEpic(db: Database, epicId: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE epic_id = $e").all({ $e: epicId }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}
/** Stamp PR facts sensed from the session's cwd git worktree (VCS-intrinsic only). */
export function stampPrFacts(
  db: Database,
  sessionId: string,
  facts: PrFacts | null,
  now: string,
): void {
  ensureRow(db, sessionId, now);
  if (facts === null) {
    db.query(
      `UPDATE catalogue
       SET pr_number = NULL, pr_repo = NULL, pr_branch = NULL, pr_state = NULL, pr_head_sha = NULL,
           updated_at = $now
       WHERE session_id = $id`,
    ).run({ $now: now, $id: sessionId });
  } else {
    db.query(
      `UPDATE catalogue
       SET pr_number = $num, pr_repo = $repo, pr_branch = $branch, pr_state = $state,
           pr_head_sha = $sha, updated_at = $now
       WHERE session_id = $id`,
    ).run({
      $num: facts.prNumber,
      $repo: facts.prRepo,
      $branch: facts.prBranch,
      $state: facts.prState,
      $sha: facts.prHeadSha,
      $now: now,
      $id: sessionId,
    });
  }
}

/** Reverse lookup: which sessions are assigned to this key. */
export function sessionsForKey(db: Database, key: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE key = $k").all({ $k: key }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/**
 * @deprecated Use `sessionsForKey` instead. This alias reads from `key` for backward compatibility.
 */
export function sessionsForEvent(db: Database, event: string): string[] {
  return sessionsForKey(db, event);
}

/** Reverse lookup: which sessions are assigned to this project label. */
export function sessionsForProject(db: Database, project: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE project = $p").all({ $p: project }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: which sessions are assigned to this system grouping. */
export function sessionsForSystem(db: Database, system: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE system = $s").all({ $s: system }) as {
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
