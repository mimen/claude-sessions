import { Database } from "bun:sqlite";

/**
 * The Catalogue: durable, user-authored session metadata that the Index cache cannot hold
 * (it gets dropped on schema bumps). Stored in its own SQLite file (see paths.CATALOGUE_PATH())
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
  /** DEPRECATED (ADR-0015): the old "backing skill/slash-command" axis, overloaded as role.
   * Kept for migration safety (additive-only, never dropped); superseded by `role`. */
  skill: string | null;
  /** The session's ROLE — first-class identity axis (control, concierge, scout, pr-agent…).
   * Replaces `skill`. Reads fall back to `skill` when unset (pre-migration rows). */
  role: string | null;
  /** How this session is re-armed on resume so it comes back RUNNING (e.g. a loop's
   * `/loop 15m /pr-watch-control`). Null for non-looping roles (a worker gets a bare resume,
   * then rehydrates). ADR-0015. */
  resumeCommand: string | null;
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
  /** Reference to the work-unit ENTITY this session belongs to (ADR-0057). A work-unit
   * is a first-class entity with a stable id; PR/GUS/cwd are attributes, not identity.
   * Sessions reference it by FK (mirrors epicId). Nullable (session may not belong to
   * a work-unit, or work-unit not yet created). */
  workUnitId: string | null;
  /** Reference to the epic ENTITY this session's work belongs to (a FK into the
   * `epics` table, which holds the epic's name + url). A session points at one epic;
   * the name/url live once on the entity, not copied per session. Set by the fleet
   * orchestrator from its W->epic resolution. Nullable. */
  epicId: string | null;
  /** @deprecated superseded by stage × activity (v19). Kept for old rows / non-pr-watch systems. */
  phase: string | null;
  /** The pr-agent PR STAGE: building | milad-review | in-review | approved | merged. Monotonic,
   * forward-only, engine-latched (see roles/pr-agent/docs/phase-state-machine.md). */
  stage: string | null;
  /** The ACTIVITY within the current stage: working | needs-you | fixing. Worker self-reports
   * working/needs-you; fixing is engine-sensed. Orthogonal to `stage`. */
  activity: string | null;
  /** A short freeform status a session writes about ITSELF (≤2 lines), shown on its tab.
   * Human-readable prose (vs `phase`'s controlled vocabulary). Set via `ccs status`. */
  statusLine: string | null;
  /** Milad's +1 verdict on this PR (the submitter-review signal): "approved" or null. One field,
   * many writers (ccs approve / sensed / self-report); the gate reads it. Set via `ccs approve`. */
  miladReview: string | null;
  /** The monotonic build→review latch: true once phase first hit `milad-review`. Once true the
   * phase projection never returns `building` (see phase-state-machine.md). */
  buildComplete: boolean;
  /** Generic per-session metadata map (ADR-0060): cluster/role-specific scratch state (latches,
   * flags, counters) that doesn't fit the blessed stage/activity columns. ccs stores + stamps it
   * but does NOT interpret it — the cluster's state machine defines what keys exist and mean. */
  meta: Record<string, unknown>;
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

const CATALOGUE_VERSION = 21;

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
  if (v < 12) {
    // Additive: `role` (first-class, replaces the overloaded `skill`) + `resume_command`
    // (how a loop is re-armed so it comes back RUNNING). ADR-0015 abandons `skill` as an
    // identity axis; we keep the column (additive-only, never drop) and backfill role from
    // it, so old rows keep working and reads fall back to skill when role is unset.
    if (!hasColumn(db, "catalogue", "role")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN role TEXT;");
    }
    if (!hasColumn(db, "catalogue", "resume_command")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN resume_command TEXT;");
    }
    // one-time backfill: seed role from the legacy skill where role is still empty
    db.exec("UPDATE catalogue SET role = skill WHERE role IS NULL AND skill IS NOT NULL;");
  }
  if (v < 13) {
    // Additive: the ROLES registry (ADR-0022) — a first-class entity like `epics`. Holds
    // each role's runtime wiring: cluster grouping (optional), kind, home dir, resume_command
    // template, and the skills/commands/hooks to materialize into ~/.claude (JSON arrays).
    // Sessions reference a role by its free-form `role` string (ADR-0015); this table is the
    // source of truth for role DEFINITIONS.
    db.exec(`
      CREATE TABLE IF NOT EXISTS roles (
        role           TEXT PRIMARY KEY,
        cluster        TEXT,
        kind           TEXT,
        home_dir       TEXT,
        resume_command TEXT,
        skills         TEXT,
        commands       TEXT,
        hooks          TEXT,
        updated_at     TEXT
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_roles_cluster ON roles(cluster);");
  }
  if (v < 14) {
    // ADR-0050: role DEFINITIONS are read from config FILES now (src/roles/role-files.ts), so
    // the `roles` table is no longer a source of truth. DROP it — the one deliberate exception
    // to "additive only" (a duplicated definition store is worse than a drop). Definitions live
    // in ~/.ccs-config; nothing rebuilds this table.
    db.exec("DROP TABLE IF EXISTS roles;");
  }
  if (v < 15) {
    // ADR-0051: a grouping's DISPLAY metadata (name/link/shortname) + notes are CLUSTER RUNTIME
    // state (src/state/groupings.ts), written by the cluster's adapter — not a platform table
    // that leaked a GUS concept into the schema. DROP `epics`; the generic `epic_id` grouping
    // axis stays on the catalogue row (+ its index). Same deliberate exception as v14.
    db.exec("DROP TABLE IF EXISTS epics;");
  }
  if (v < 16) {
    // Additive: `status_line` — a short freeform status a session writes about ITSELF (≤2 lines),
    // shown on its cmux tab when there's something worth saying, else cleared. Universal (any
    // role can set one via `ccs status`); scout authors its own, the engine can set the mechanical
    // ones. Distinct from `phase` (a controlled vocabulary → pill) — this is human-readable prose.
    if (!hasColumn(db, "catalogue", "status_line")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN status_line TEXT;");
    }
  }
  if (v < 17) {
    // Additive: `milad_review` — Milad's +1 verdict on a worker's PR (the submitter-review signal).
    // ONE field, MANY writers (ccs approve / a sensed Slack-GitHub "looks good" / self-report), so
    // how the +1 arrives never matters — only that the field is set. The gate reads it for its
    // submitter box; when set, a worker's `milad-review` phase advances to `in-review`. Values:
    // "approved" (the +1 given) or NULL (not yet). Distinct from an external reviewer's approval.
    if (!hasColumn(db, "catalogue", "milad_review")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN milad_review TEXT;");
    }
  }
  if (v < 18) {
    // Additive: `build_complete` — the MONOTONIC latch that makes the build→review hinge one-way
    // (see roles/pr-agent/docs/phase-state-machine.md). Flips 1 the first time phase becomes
    // `milad-review`; once set, the phase projection is forbidden from returning `building`
    // (needs-you resolves to milad-review, fixing becomes reachable). Never flips back. 0/NULL =
    // still in the build loop; 1 = review loop, building sealed off.
    if (!hasColumn(db, "catalogue", "build_complete")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN build_complete INTEGER;");
    }
  }
  if (v < 19) {
    // The pr-agent phase is now STAGE × ACTIVITY (see roles/pr-agent/docs/phase-state-machine.md).
    //  - `stage`: building | milad-review | in-review | approved | merged — monotonic, forward-only
    //    (each step latched: buildComplete/miladApproved/approved/merged). Engine-sensed.
    //  - `activity`: working | needs-you | fixing — the mini-loop inside ANY stage. Worker self-
    //    reports working/needs-you; fixing is engine-sensed (CI red / conflict / changes-requested).
    // The old single `phase` column stays (additive-only) but is superseded by these two.
    if (!hasColumn(db, "catalogue", "stage")) db.exec("ALTER TABLE catalogue ADD COLUMN stage TEXT;");
    if (!hasColumn(db, "catalogue", "activity")) db.exec("ALTER TABLE catalogue ADD COLUMN activity TEXT;");
  }
  if (v < 20) {
    // Additive: work_unit_id — a session's FK to its work-unit ENTITY (ADR-0057). A work-unit is
    // a first-class entity with a stable id (cluster state, like grouping); PR/GUS/cwd are attributes
    // that attach to it, not its identity. This mirrors epic_id (grouping FK). Nullable (session may
    // not belong to a work-unit). Guard on column presence (older binary can reset version, re-run).
    if (!hasColumn(db, "catalogue", "work_unit_id")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN work_unit_id TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_work_unit ON catalogue(work_unit_id);");
  }
  if (v < 21) {
    // Additive: meta — a generic JSON blob for cluster/role-specific scratch state (ADR-0060).
    // stage/activity are blessed columns (many roles need them, displayed as real columns); everything
    // else role-specific (latches, flags, counters for a role's state machine) lives in this map.
    // ccs stores + stamps it but does NOT interpret it. Guard on column presence (older binary can
    // reset version, re-run). No index — meta is per-session display/scratch, not a grouping axis.
    if (!hasColumn(db, "catalogue", "meta")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN meta TEXT;");
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
    // role is canonical; fall back to the legacy skill for rows written before v12
    role: (r.role as string) ?? (r.skill as string) ?? null,
    resumeCommand: (r.resume_command as string) ?? null,
    project: (r.project as string) ?? null,
    system: (r.system as string) ?? null,
    gusWork: (r.gus_work as string) ?? null,
    workUnitId: (r.work_unit_id as string) ?? null,
    epicId: (r.epic_id as string) ?? null,
    phase: (r.phase as string) ?? null,
    stage: (r.stage as string) ?? null,
    activity: (r.activity as string) ?? null,
    statusLine: (r.status_line as string) ?? null,
    miladReview: (r.milad_review as string) ?? null,
    buildComplete: r.build_complete === 1,
    meta: r.meta ? JSON.parse(r.meta as string) : {},
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
export function ensureRow(db: Database, sessionId: string, now: string): void {
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

/** Bump updated_at on a session (creating the row if absent) without changing any field. */
export function touch(db: Database, sessionId: string, now: string): void {
  ensureRow(db, sessionId, now);
  db.query("UPDATE catalogue SET updated_at = $now WHERE session_id = $id").run({
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
/** Set the session's ROLE (ADR-0015) — the canonical identity axis replacing `skill`. */
export function setRole(db: Database, sessionId: string, role: string | null, now: string): void {
  set(db, sessionId, "role", role, now);
}
/** Set how a session is re-armed on resume (a loop's resume_command); null for non-loops. */
export function setResumeCommand(db: Database, sessionId: string, cmd: string | null, now: string): void {
  set(db, sessionId, "resume_command", cmd, now);
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
/** Set the session's work-unit FK (ADR-0057) — the work-unit entity it belongs to. */
export function setWorkUnitId(db: Database, sessionId: string, workUnitId: string | null, now: string): void {
  set(db, sessionId, "work_unit_id", workUnitId, now);
}
export function setPhase(db: Database, sessionId: string, phase: string | null, now: string): void {
  set(db, sessionId, "phase", phase, now);
}

/** The PR stage (building|milad-review|in-review|approved|merged). Engine-latched; forward-only. */
export function setStage(db: Database, sessionId: string, stage: string | null, now: string): void {
  set(db, sessionId, "stage", stage, now);
}

/** The activity within the current stage (working|needs-you|fixing). */
export function setActivity(db: Database, sessionId: string, activity: string | null, now: string): void {
  set(db, sessionId, "activity", activity, now);
}

/** A short freeform status a session writes about itself (≤2 lines on its tab). null clears it. */
export function setStatusLine(db: Database, sessionId: string, statusLine: string | null, now: string): void {
  set(db, sessionId, "status_line", statusLine, now);
}

/** Milad's +1 verdict on a PR (submitter-review signal): "approved" to grant, null to revoke. */
export function setMiladReview(db: Database, sessionId: string, verdict: string | null, now: string): void {
  set(db, sessionId, "milad_review", verdict, now);
}

/**
 * Set a key in the session's meta map (ADR-0060). Reads the current meta JSON, merges the key/value,
 * writes back. If value is null, the key is deleted from the map. Meta is cluster/role-specific scratch
 * state (latches, flags, counters); ccs stores it but does NOT interpret it.
 */
export function setMeta(db: Database, sessionId: string, key: string, value: unknown, now: string): void {
  ensureRow(db, sessionId, now);
  const row = getRow(db, sessionId);
  const meta = row?.meta ?? {};
  if (value === null) {
    delete meta[key];
  } else {
    meta[key] = value;
  }
  const metaJson = JSON.stringify(meta);
  db.query("UPDATE catalogue SET meta = $m, updated_at = $now WHERE session_id = $id").run({
    $m: metaJson,
    $now: now,
    $id: sessionId,
  });
}

/**
 * Get a key from a row's meta map (ADR-0060). Pure accessor — reads the row's meta, returns the key's
 * value, or undefined if absent. The row's meta is already parsed (rowFrom() handles JSON deserialization).
 */
export function getMeta(row: CatalogueRow, key: string): unknown {
  return row.meta[key];
}

/** Reverse lookup: which sessions are working this GUS work item (a work-unit may span sessions). */
export function sessionsForGusWork(db: Database, gusWork: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE gus_work = $g").all({ $g: gusWork }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: which sessions belong to this work-unit (ADR-0057). */
export function sessionsForWorkUnit(db: Database, workUnitId: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE work_unit_id = $wu").all({ $wu: workUnitId }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: sessions assigned to a role (the canonical identity axis, ADR-0015). */
export function sessionsForRole(db: Database, role: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE role = $r").all({ $r: role }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: sessions on a PR. Repo optional — `#123` matches the number across repos. */
export function sessionsForPr(db: Database, prNumber: number, prRepo?: string): string[] {
  const rows = prRepo
    ? (db
        .query("SELECT session_id FROM catalogue WHERE pr_number = $n AND pr_repo = $repo")
        .all({ $n: prNumber, $repo: prRepo }) as { session_id: string }[])
    : (db
        .query("SELECT session_id FROM catalogue WHERE pr_number = $n")
        .all({ $n: prNumber }) as { session_id: string }[]);
  return rows.map((r) => r.session_id);
}

// ---- Grouping axis (epic) ------------------------------------------------------
// `epic_id` on a session is a GENERIC grouping axis (ADR-0051). The grouping's DISPLAY metadata
// (name/link/shortname) + notes are CLUSTER RUNTIME state (src/state/groupings.ts), written by
// the cluster's adapter — NOT a hardcoded platform `epics` table (which was dropped, v15). GUS
// is one adapter behind that seam, not a platform concept. Only the row-FK operations live here.

/** Point a session at its grouping (the epic_id axis). null clears it. */
export function setSessionEpic(db: Database, sessionId: string, epicId: string | null, now: string): void {
  set(db, sessionId, "epic_id", epicId, now);
}

/** Reverse lookup: sessions belonging to a grouping. */
export function sessionsForEpic(db: Database, epicId: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE epic_id = $e").all({ $e: epicId }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

// --- roles registry (ADR-0022) -------------------------------------------------

/** A role DEFINITION: its runtime wiring + what to materialize into ~/.claude. */
export interface RoleDef {
  role: string;
  /** Optional cluster grouping (nullable — a role can stand alone, ADR-0022). */
  cluster: string | null;
  kind: Kind | null;
  /** Where sessions of this role spawn (permission/statusLine scope, ADR-0018/0036). */
  homeDir: string | null;
  /** How a loop role is re-armed on resume (ADR-0015); null for non-loop roles. */
  resumeCommand: string | null;
  /** Skills / commands / hooks to materialize into ~/.claude for this role (ADR-0034). */
  skills: string[];
  commands: string[];
  hooks: string[];
  updatedAt: string | null;
}

// Role DEFINITIONS are read from config FILES now (ADR-0048/0050), not a sqlite table — see
// src/roles/role-files.ts. The `RoleDef` type stays (shared shape); the `roles` table + its
// accessors were removed. The `roles` table is dropped in the migration below.

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
