import { Database } from "bun:sqlite";
import type { StoredEnrichment } from "./enrichment.ts";

export type { StoredEnrichment } from "./enrichment.ts";

/**
 * The Catalogue: durable, user-authored session metadata that the Index cache cannot hold
 * (it gets dropped on schema bumps). Stored in its own SQLite file (see paths.CATALOGUE_PATH())
 * so the Index can be nuked/rebuilt without ever touching this.
 *
 * Migrations are version-gated, presence-guarded, and applied in one transaction. Some
 * reviewed migrations deliberately retire superseded columns after preserving their data.
 */

export type Kind = "session" | "loop";
export type Lifecycle = "idle" | "parked" | "saved" | "completed" | "archived";
export type PrState = "open" | "merged" | "closed";
export type SessionClass = "work_body" | "auxiliary";
export type CreatorKind = "human" | "agent" | "automation";
export type LaunchChannel =
  | "claude_shim"
  | "ccs_session_new"
  | "ccs_delegate"
  | "native_agent_inferred"
  | "repair";

export interface CatalogueRow {
  sessionId: string;
  resumeId: string | null;
  customTitle: string | null;
  kind: Kind;
  completed: boolean;
  archived: boolean;
  /** Resumable work intentionally hidden from the active working set. */
  saved: boolean;
  parkedTaskId: string | null;
  /**
   * Excluded from every listing, aggregate, and enrichment path — and, critically, never sent to
   * the model gateway and never composed into another session's prompt. Distinct from `archived`,
   * which only hides a row from active views while leaving all of that machinery running.
   *
   * Optional in the same way as `substrate` and `launcherIdentity`: hydration always populates it,
   * so a reader can treat absence as false, but fixtures built before the column existed stay
   * valid without a sweep through every test file.
   */
  incognito?: boolean;
  /** Neutral, opaque identity key for system-level grouping. */
  key: string | null;
  /** The causal session that spawned this body; descendant cost belongs to it. */
  parentSessionId: string | null;
  /** Explicit birth intent. Null is retained for legacy/plain sessions. */
  sessionClass: SessionClass | null;
  /** Who caused this birth. Null remains honest for legacy/unmanaged sessions. */
  creatorKind?: CreatorKind | null;
  /** Launching session id for agents or stable daemon/job id for automations. */
  creatorRef?: string | null;
  /** Managed path that registered or inferred the birth. */
  launchChannel?: LaunchChannel | null;
  /** Fork lineage only; never used for causal cost ancestry. */
  forkedFromSessionId?: string | null;
  /** The session's ROLE — first-class identity axis (control, concierge, scout, pr-agent…). */
  role: string | null;
  /** How this session is re-armed on resume so it comes back RUNNING (e.g. a loop's
   * `/loop 15m /pr-watch-control`). Null for non-looping roles (a worker gets a bare resume,
   * then rehydrates). ADR-0015. */
  resumeCommand: string | null;
  /** User-assigned project/initiative label — groups otherwise-solo sessions (e.g. `ccs`). */
  project: string | null;
  /** Operation-level grouping (e.g. `pr-watch`) — sits between constellation and session. */
  cluster: string | null;
  /** Work-tracker id (e.g. a GUS W-number) this session is working — a structured,
   * stable identification layer (ADR-0013). Set when work starts, survives the whole
   * lifecycle, never renamed; an extra axis alongside pr_* (and better than the opaque
   * `key` for pr-watch). The FLEET ORCHESTRATOR owns what it means / membership; ccs
   * just stores it. Nullable (orphan PR = no ticket). */
  gusWork: string | null;
  /** Reference to the work-unit ENTITY this session belongs to (ADR-0057). A work-unit
   * is a first-class entity with a stable id; PR/GUS/cwd are attributes, not identity.
   * Sessions reference it by FK (mirrors groupingId). Nullable (session may not belong to
   * a work-unit, or work-unit not yet created). */
  workUnitId: string | null;
  /** Reference to the GROUPING entity this session's work belongs to (ADR-0070): an opaque FK to a
   * grouping of the cluster's declared type (pr-watch = epic). Display metadata (label/url/notes)
   * lives in cluster state (groupings.ts), not here. Set by the cluster's sensor. Nullable. */
  groupingId: string | null;
  /** The pr-agent PR STAGE: building | milad-review | in-review | approved | merged. Monotonic,
   * forward-only, engine-latched (see roles/pr-agent/docs/phase-state-machine.md). */
  stage: string | null;
  /** A short freeform status a session writes about ITSELF (≤2 lines), shown on its tab.
   * Human-readable prose (vs `phase`'s controlled vocabulary). Set via `ccs status`. */
  statusLine: string | null;
  /** Generic per-session metadata map (ADR-0060): cluster/role-specific scratch state (latches,
   * flags, counters) that doesn't fit the blessed stage/activity columns. ccs stores + stamps it
   * but does NOT interpret it — the cluster's state machine defines what keys exist and mean.
   * pr-watch uses "milad_review" (submitter +1) and "build_complete" (build→review latch) keys. */
  meta: Record<string, unknown>;
  notes: string | null;
  updatedAt: string | null;
  /** PR facts sensed from the session's cwd git worktree (VCS-intrinsic only). */
  prNumber: number | null;
  prRepo: string | null;
  prBranch: string | null;
  prState: PrState | null;
  prHeadSha: string | null;
  /** ADR-0089: FK to identities.identity_key. Nullable for "loose" sessions with no cluster/role. */
  identityKey: string | null;
  /** Agent runtime that hosted this body. Null reads as the default `claude-code`. Salvage
   *  from origin's v5 — makes ccs honest about hosting non-Claude agents (grok, codex, …)
   *  when we decide to. Optional for test fixtures constructed before v34. */
  substrate?: string | null;
  /** The launcher's `CLAUDE_IDENTITY` env var, if it exported one — which `claude-<alias>`
   *  started this body. Distinct from `identityKey` (our durable work-unit key); this is a
   *  provenance breadcrumb from the invocation environment. Optional for pre-v34 fixtures. */
  launcherIdentity?: string | null;
  /** OBSERVED state from one inference pass over the transcript (v38). Null until first enriched.
   *  Distinct from lifecycle, which is stored INTENT — the gap between them is the signal. */
  enrichment?: StoredEnrichment | null;
  /** Failed enrichment attempts. Capped so one unparseable session never retries forever. */
  enrichmentAttempts?: number;
}

/** Effective substrate for a row (defaults unset rows to claude-code). */
export const DEFAULT_SUBSTRATE = "claude-code";
export function substrateOf(row: CatalogueRow | null): string {
  return row?.substrate ?? DEFAULT_SUBSTRATE;
}

export interface PrFacts {
  prNumber: number;
  prRepo: string;
  prBranch: string;
  prState: PrState;
  prHeadSha: string;
}

const CATALOGUE_VERSION = 40;
const LEGACY_IDENTITY_COLUMNS = [
  "role", "system", "cluster", "project", "event",
  "pr_number", "pr_repo", "pr_branch", "pr_state", "pr_head_sha",
  "gus_work", "work_unit_id", "epic_id", "grouping_id",
  "key", "stage", "status_line",
] as const;
const LEGACY_IDENTITY_META_KEY = "__ccs_legacy_identity";

type StoredMetaValue =
  | string
  | number
  | boolean
  | null
  | StoredMetaValue[]
  | { [key: string]: StoredMetaValue };

/**
 * ADR-0089: derive the structured identity key `<cluster>:<role>:<work_ref>` for fleet, or
 * `<cluster>:<role>` for core. Nullable if we don't have enough to pin an identity (e.g. a
 * loose session with no role/cluster). This is a DIFFERENT SHAPE from deriveKey() — the old
 * `pr:owner/repo#12345` was a "generic identity fingerprint" that ignored cluster/role; the
 * new form makes cluster + role first-class so pr-agent on pr-watch and (hypothetical)
 * pr-agent on another cluster never collide.
 *
 * Preferred work_ref shapes, in priority order:
 *   1. PR (repo#number) — pr-watch's canonical worker
 *   2. GUS work item — a ticketed-no-PR row
 *   3. work_unit_id — an opaque work-unit entity
 * Core roles (no work_ref) collapse to `<cluster>:<role>`.
 */
export function deriveIdentityKey(row: {
  cluster?: string | null;
  role?: string | null;
  prRepo?: string | null;
  prNumber?: number | null;
  gusWork?: string | null;
  workUnitId?: string | null;
}): string | null {
  if (!row.cluster || !row.role) return null;
  const workRef =
    row.prRepo && row.prNumber != null
      ? `${row.prRepo}#${row.prNumber}`
      : row.gusWork
      ? row.gusWork
      : row.workUnitId
      ? row.workUnitId
      : null;
  return workRef ? `${row.cluster}:${row.role}:${workRef}` : `${row.cluster}:${row.role}`;
}

export function openCatalogue(
  dbPath: string,
  options: { readonly materialize?: boolean } = {},
): Database {
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    configureWal(db);
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  // Exact-manifest transactional maintenance must not incidentally import filesystem-derived
  // identity/grouping/inbox state. It still receives required catalogue schema migrations above.
  if (options.materialize === false) return db;
  // ADR-0089 step 3: materialize per-fleet-role identity tables from each role's
  // identity-schema.toml under ~/.ccs-config/clusters/<c>/roles/<r>/. Additive-only,
  // idempotent. Only fires when a config root is discoverable — tests using
  // openCatalogue(":memory:") without a config-root env var get skipped materialization,
  // which is what we want for isolated unit tests.
  try {
    // Lazy-import to avoid a cycle at module load — identity-schema.ts pulls role-files.ts,
    // which imports from ../inbox/identity-path.ts, which in turn touches other subsystems.
    // Keeping this lazy makes db-schema.ts safe to import from anywhere.
    const { materializeAllIdentityTables } = require("./identity-schema.ts");
    materializeAllIdentityTables(db);
  } catch (e) {
    // Fail-open: if the config root isn't readable (fresh install, tests, permission issue),
    // ccs still boots. Fleet-role writes will surface a friendly error later ("no
    // identity_<role> table exists"). The alternative — hard-failing on missing config —
    // makes ccs unusable during setup.
    if (process.env.CCS_DEBUG_MATERIALIZE) {
      console.error("ccs: identity-schema materialization skipped:", (e as Error).message);
    }
  }
  // ADR-0089 step 4: migrate any ~/.ccs/clusters/<c>/cluster/groupings.json files into the
  // groupings table. Idempotent — rows already in the DB are skipped. Fails-open like the
  // materialization above.
  try {
    const { migrateGroupingsJsonToDb } = require("../state/groupings-migrate.ts");
    migrateGroupingsJsonToDb(db);
  } catch (e) {
    if (process.env.CCS_DEBUG_MATERIALIZE) {
      console.error("ccs: groupings migration skipped:", (e as Error).message);
    }
  }
  // ADR-0089 step 5: migrate filesystem inboxes into the inboxes table.
  try {
    const { migrateFileInboxesToDb } = require("../inbox/inbox-migrate.ts");
    migrateFileInboxesToDb(db);
  } catch (e) {
    if (process.env.CCS_DEBUG_MATERIALIZE) {
      console.error("ccs: inbox migration skipped:", (e as Error).message);
    }
  }
  return db;
}

const WAL_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** SQLite can bypass busy_timeout during rollback-journal → WAL conversion to avoid a lock
 * upgrade deadlock. Retry only SQLITE_BUSY/locked failures within the same five-second budget. */
function configureWal(db: Database): void {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !/(SQLITE_BUSY|database is locked)/i.test(detail)) throw error;
      Atomics.wait(WAL_RETRY_WAIT, 0, 0, Math.min(50, remaining));
    }
  }
}

/** After migrate() has stamped user_version=CATALOGUE_VERSION, verify the actual schema
 * matches. Presence-driven recovery must not stamp a malformed or only partially retired
 * catalogue current. This checks both required columns and complete legacy-column removal. */
function validateSchemaPostcondition(db: Database): { ok: true } | { ok: false; error: string } {
  // ADR-0089 v33: identity attrs moved to identities + identity_<role> tables. Catalogue
  // holds only per-run session state now.
  const required = [
    "session_id",
    "identity_key",
    "meta",
    "updated_at",
    "session_class",
    "saved",
    "creator_kind",
    "creator_ref",
    "launch_channel",
    "forked_from_session_id",
    // v38 enrichment. Only the two provenance columns are asserted: they are what the sweep's
    // staleness check reads, so a partially-applied v38 that kept them would still be safe to
    // run against, while one that lost them would silently re-enrich the whole store.
    "enrichment_at",
    "enrichment_at_messages",
    // v40. `enrichment_state` is asserted for the same reason the provenance pair is: it is the
    // field every reader leads with, so a half-applied v40 that lost it would render blank panels
    // for an entire store while reporting itself current.
    "enrichment_state",
    "enrichment_next",
  ];
  const cols = (db.query("PRAGMA table_info(catalogue)").all() as { name: string }[]).map((c) => c.name);
  const present = new Set(cols);
  const missing = required.filter((c) => !present.has(c));
  if (missing.length > 0) {
    return { ok: false, error: `catalogue missing required column(s): ${missing.join(", ")}` };
  }
  const retainedLegacy = LEGACY_IDENTITY_COLUMNS.filter((column) => present.has(column));
  if (retainedLegacy.length > 0) {
    return {
      ok: false,
      error: `catalogue retains legacy identity column(s): ${retainedLegacy.join(", ")}`,
    };
  }
  return { ok: true };
}

function migrate(db: Database): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    applyMigrations(db);
    // Validate before COMMIT so a presence-driven migration can never stamp a malformed
    // schema current. Any failure rolls back both DDL and PRAGMA user_version together.
    const post = validateSchemaPostcondition(db);
    if (!post.ok) {
      throw new Error(`catalogue schema postcondition failed: ${post.error}`);
    }
    db.exec("COMMIT;");
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // Preserve the migration error; rollback failure is secondary and the connection is unusable.
    }
    throw error;
  }
}

function applyMigrations(db: Database): void {
  const v = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  // Each block is version-gated and presence-guarded for legacy binary/retry compatibility.
  if (v < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS catalogue (
        session_id     TEXT PRIMARY KEY,
        resume_id      TEXT,
        custom_title   TEXT,
        kind           TEXT NOT NULL DEFAULT 'session',
        completed      INTEGER NOT NULL DEFAULT 0,
        archived       INTEGER NOT NULL DEFAULT 0,
        saved          INTEGER NOT NULL DEFAULT 0,
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
    // Nullable; no backfill. (Note: this was originally `system`; renamed to `cluster` in v27.)
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
    // full name — for the grouping header / a narrow column. A current DB down-stamped to v9
    // has already retired `epics`, so table absence means there is nothing left to migrate.
    if (hasTable(db, "epics") && !hasColumn(db, "epics", "short_name")) {
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
    // one-time backfill: seed role from the legacy skill where role is still empty.
    // A retry after v25 may already have dropped skill while user_version is still old.
    if (hasColumn(db, "catalogue", "skill")) {
      db.exec("UPDATE catalogue SET role = skill WHERE role IS NULL AND skill IS NOT NULL;");
    }
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
  if (v < 22) {
    // ADR-0060 backfill: migrate existing milad_review + build_complete column values into the
    // meta JSON map. For each row where these columns are non-NULL/non-zero, copy the value into
    // the meta map under "milad_review" / "build_complete" keys. After this, step 3 (v23) will
    // drop the columns. Guard on column presence (older binary can reset version, re-run).
    const hasMiladReview = hasColumn(db, "catalogue", "milad_review");
    const hasBuildComplete = hasColumn(db, "catalogue", "build_complete");
    if (hasMiladReview || hasBuildComplete) {
      const rows = db.query(
        `SELECT session_id,
                ${hasMiladReview ? "milad_review" : "NULL AS milad_review"},
                ${hasBuildComplete ? "build_complete" : "NULL AS build_complete"},
                meta
         FROM catalogue`,
      ).all() as Array<{
        session_id: string;
        milad_review: string | null;
        build_complete: number | null;
        meta: string | null;
      }>;
      const update = db.prepare("UPDATE catalogue SET meta = ? WHERE session_id = ?");
      for (const r of rows) {
        const meta = parseCatalogueMetaObject(r.meta, r.session_id);
        let changed = false;
        if (r.milad_review !== null && meta.milad_review === undefined) {
          meta.milad_review = r.milad_review;
          changed = true;
        }
        if (r.build_complete === 1 && meta.build_complete === undefined) {
          meta.build_complete = true;
          changed = true;
        }
        if (changed) {
          update.run(JSON.stringify(meta), r.session_id);
        }
      }
    }
  }
  if (v < 23) {
    // ADR-0060 final step: drop milad_review + build_complete columns now that data is backfilled
    // into meta (v22) and readers use getMeta() (step 1). SQLite 3.35+ supports ALTER TABLE DROP COLUMN.
    // Guard on column presence (older binary can reset version, re-run).
    if (hasColumn(db, "catalogue", "milad_review")) {
      db.exec("ALTER TABLE catalogue DROP COLUMN milad_review;");
    }
    if (hasColumn(db, "catalogue", "build_complete")) {
      db.exec("ALTER TABLE catalogue DROP COLUMN build_complete;");
    }
  }
  if (v < 24) {
    // ADR-0059: remove `event` (canonical is `key`). Backfill key from event, then drop event.
    // Guard on column presence (older binary can reset version, re-run).
    if (hasColumn(db, "catalogue", "event")) {
      db.exec("UPDATE catalogue SET key = event WHERE key IS NULL AND event IS NOT NULL;");
      db.exec("DROP INDEX IF EXISTS idx_catalogue_event;");
      db.exec("ALTER TABLE catalogue DROP COLUMN event;");
    }
  }
  if (v < 25) {
    // ADR-0059: remove `skill` (canonical is `role`). Backfill role from skill, then drop skill.
    // Guard on column presence (older binary can reset version, re-run).
    if (hasColumn(db, "catalogue", "skill")) {
      db.exec("UPDATE catalogue SET role = skill WHERE role IS NULL AND skill IS NOT NULL;");
      db.exec("ALTER TABLE catalogue DROP COLUMN skill;");
    }
  }
  if (v < 26) {
    // ADR-0059: remove the free-form `phase` column — superseded by stage × activity (v19). No
    // backfill: `phase` was a legacy display string with no clean mapping to a stage; readers moved
    // to `stage` (statusline dot / pill) and the loop-status pill that rode on it was retired.
    if (hasColumn(db, "catalogue", "phase")) {
      db.exec("ALTER TABLE catalogue DROP COLUMN phase;");
    }
  }
  // ADR-0059: rename `system` to `cluster`. Reconcile by column presence even when the
  // version is already >= 27: interrupted pre-transaction migrations could leave both names,
  // or stamp v27 while the only populated value remained in `system`.
  reconcileLegacyRename(db, "system", "cluster", v < 32);
  if (v < 27) {
    db.exec("DROP INDEX IF EXISTS idx_catalogue_system;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_cluster ON catalogue(cluster);");
  }

  // ADR-0070: rename `epic_id` to `grouping_id` with the same presence-driven recovery.
  reconcileLegacyRename(db, "epic_id", "grouping_id", v < 32);
  if (v < 28) {
    db.exec("DROP INDEX IF EXISTS idx_catalogue_epic;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_grouping ON catalogue(grouping_id);");
  }
  if (v < 29) {
    // ADR-0062: drop the `kind` + `resume_command` columns. Both are DERIVED from the role now
    // (role.toml is files-are-truth): a role re-arms iff it declares a resume_command ⇒ it's a
    // "loop". No backfill — the derivation (rowFrom → roleResumeCommand) replaces the stored values.
    // Guard on presence (older binary can reset version, re-run). SQLite 3.35+ DROP COLUMN.
    if (hasColumn(db, "catalogue", "kind")) db.exec("ALTER TABLE catalogue DROP COLUMN kind;");
    if (hasColumn(db, "catalogue", "resume_command")) db.exec("ALTER TABLE catalogue DROP COLUMN resume_command;");
  }
  if (v < 30) {
    // Drop the `activity` column entirely (2026-07-13). The stage × activity model was retired:
    // the sensor-driven activity latches (fixing) never had a clean off-ramp, worker-set values
    // (needs-you) fought stage transitions, and every "worker interaction" scheme we tried after
    // (blocked_on_input from Notification, etc.) produced false positives. Stage alone — pure
    // sensor-computed truth — is the state pill. `gate.route` on the composed board answers
    // "whose turn is it?"; no separate axis needed. Guard on presence + fail-open.
    if (hasColumn(db, "catalogue", "activity")) db.exec("ALTER TABLE catalogue DROP COLUMN activity;");
  }
  // v31 historically derived the soon-to-be-retired `key` column. The v32 identity backfill
  // derives its own structured key directly from source columns, and v33 drops `key`, so writing
  // a synthetic value here would only pollute the recovery evidence preserved below.
  // ADR-0089: identity as a first-class entity. Introduces the universal tables that hold
  // durable per-work-item state (identities, groupings, inboxes, identity_state, dispositions,
  // schema_migrations). Sessions keep their columns FOR NOW — the drop of the now-redundant
  // columns lives in a later refactor step once every caller reads through the new tables.
  //
  // The DDL below runs on EVERY openCatalogue() (IF NOT EXISTS is idempotent) so a DB that
  // got stamped v32 without the tables gets healed on next boot. The row-level backfill is
  // guarded on `v < 32` so it only runs once — subsequent runs write through the normal
  // mutation path.
  {
    //
    // The catalogue → sessions rename also waits for a later step; renaming the table before
    // callers migrate would break every SELECT in-flight. Keeping the table name "catalogue"
    // through the transition is a deliberate stability choice.
    db.exec(`
      CREATE TABLE IF NOT EXISTS identities (
        identity_key   TEXT PRIMARY KEY,
        cluster        TEXT NOT NULL,
        role           TEXT NOT NULL,
        kind           TEXT NOT NULL,
        grouping_id    TEXT,
        stage          TEXT,
        status_line    TEXT,
        completed      INTEGER NOT NULL DEFAULT 0,
        archived       INTEGER NOT NULL DEFAULT 0,
        saved          INTEGER NOT NULL DEFAULT 0,
        parked_task_id TEXT,
        meta           TEXT,
        created_at     TEXT,
        updated_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_identities_cluster ON identities(cluster);
      CREATE INDEX IF NOT EXISTS idx_identities_role ON identities(role);
      CREATE INDEX IF NOT EXISTS idx_identities_grouping ON identities(grouping_id);

      CREATE TABLE IF NOT EXISTS groupings (
        grouping_id    TEXT PRIMARY KEY,
        cluster        TEXT NOT NULL,
        role           TEXT NOT NULL,
        label          TEXT,
        url            TEXT,
        short_name     TEXT,
        notes          TEXT,
        context        TEXT,
        closed         INTEGER NOT NULL DEFAULT 0,
        meta           TEXT,
        updated_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_groupings_cluster ON groupings(cluster);
      CREATE INDEX IF NOT EXISTS idx_groupings_role ON groupings(role);

      CREATE TABLE IF NOT EXISTS inboxes (
        inbox_id       INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_key   TEXT NOT NULL,
        from_role      TEXT,
        message        TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending',
        created_at     TEXT NOT NULL,
        drained_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_inboxes_identity_status ON inboxes(identity_key, status);

      CREATE TABLE IF NOT EXISTS identity_state (
        identity_key   TEXT NOT NULL,
        key            TEXT NOT NULL,
        value          TEXT NOT NULL,
        updated_at     TEXT,
        PRIMARY KEY (identity_key, key)
      );

      CREATE TABLE IF NOT EXISTS dispositions (
        disposition_id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster        TEXT NOT NULL,
        subject_key    TEXT NOT NULL,
        verdict        TEXT NOT NULL,
        reason         TEXT,
        decided_by     TEXT,
        decided_at     TEXT NOT NULL,
        meta           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_dispositions_cluster_subject ON dispositions(cluster, subject_key);

      -- Applied per-role-schema migrations, so ccs can tell what's already been done to a
      -- per-fleet-role identity table (step 3 of the refactor materializes these).
      CREATE TABLE IF NOT EXISTS schema_migrations (
        role           TEXT NOT NULL,
        migration_hash TEXT NOT NULL,
        applied_at     TEXT NOT NULL,
        PRIMARY KEY (role, migration_hash)
      );

      -- Add the FK column on catalogue so a session can point at its identity. Nullable for
      -- loose sessions (no cluster/role — designer scratch, one-off transcripts). The column
      -- STARTS null and gets populated by the backfill below.
    `);
    if (!hasColumn(db, "catalogue", "identity_key")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN identity_key TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_identity ON catalogue(identity_key);");
  }

  const hasLegacyIdentityColumns = LEGACY_IDENTITY_COLUMNS.some((column) =>
    hasColumn(db, "catalogue", column)
  );
  if ((v < 33 || hasLegacyIdentityColumns) && hasColumn(db, "catalogue", "meta")) {
    validateCatalogueMeta(db);
  }

  const legacyIdentitySourceColumns = [
    "role",
    "cluster",
    "pr_repo",
    "pr_number",
    "gus_work",
    "work_unit_id",
    "grouping_id",
    "stage",
    "status_line",
    "completed",
    "archived",
    "parked_task_id",
    "meta",
  ] as const;
  const canBackfillLegacyIdentities = legacyIdentitySourceColumns.every((column) =>
    hasColumn(db, "catalogue", column)
  );
  if (v < 32 && canBackfillLegacyIdentities) {
    // Backfill identities from catalogue rows. Guard source-column presence because an old binary
    // can down-stamp a current v33+ schema after these columns were deliberately retired.
    // For each row that has enough info to identify
    // a work item (fleet: cluster+role+work_ref; core: cluster+role), mint an identity row and
    // point the session at it. deriveIdentityKey mirrors deriveKey's structured shape so a
    // catalogue row that already carries `key = "pr:owner/repo#12345"` maps predictably.
    const rows = db.query(
      `SELECT session_id, role, cluster, pr_repo, pr_number, gus_work, work_unit_id,
              grouping_id, stage, status_line, completed, archived, parked_task_id, meta
       FROM catalogue`,
    ).all() as Array<{
      session_id: string;
      role: string | null;
      cluster: string | null;
      pr_repo: string | null;
      pr_number: number | null;
      gus_work: string | null;
      work_unit_id: string | null;
      grouping_id: string | null;
      stage: string | null;
      status_line: string | null;
      completed: number | null;
      archived: number | null;
      parked_task_id: string | null;
      meta: string | null;
    }>;
    const nowIso = new Date().toISOString();
    const insertIdentity = db.query(
      `INSERT OR IGNORE INTO identities
         (identity_key, cluster, role, kind, grouping_id, stage, status_line,
          completed, archived, parked_task_id, meta, created_at, updated_at)
       VALUES ($k, $cluster, $role, $kind, $g, $stage, $sl, $c, $a, $p, $m, $now, $now)`,
    );
    const linkSession = db.query(
      "UPDATE catalogue SET identity_key = $k WHERE session_id = $id",
    );
    for (const r of rows) {
      const key = deriveIdentityKey({
        cluster: r.cluster,
        role: r.role,
        prRepo: r.pr_repo,
        prNumber: r.pr_number,
        gusWork: r.gus_work,
        workUnitId: r.work_unit_id,
      });
      if (!key) continue; // loose session — leave identity_key null
      // Fleet vs core: any structured work-ref means fleet; a cluster+role-only tuple is core.
      const kind = key.split(":").length > 2 ? "fleet" : "core";
      insertIdentity.run({
        $k: key,
        $cluster: r.cluster,
        $role: r.role,
        $kind: kind,
        $g: r.grouping_id,
        $stage: r.stage,
        $sl: r.status_line,
        $c: r.completed ?? 0,
        $a: r.archived ?? 0,
        $p: r.parked_task_id,
        $m: r.meta,
        $now: nowIso,
      });
      linkSession.run({ $k: key, $id: r.session_id });
    }
  }
  // ADR-0089 step 12: drop the legacy per-session identity columns whenever they're still
  // present. Idempotent (DROP INDEX IF EXISTS + hasColumn guard) so a DB stamped v33 without
  // the drop actually applied heals on next boot. Sqlite 3.35+ DROP COLUMN.
  {
    preserveLegacyIdentityEvidence(db);
    const legacyIndexes = [
      "idx_catalogue_event", "idx_catalogue_project", "idx_catalogue_role", "idx_catalogue_system",
      "idx_catalogue_cluster", "idx_catalogue_pr_number", "idx_catalogue_pr_repo",
      "idx_catalogue_key", "idx_catalogue_gus_work", "idx_catalogue_epic",
      "idx_catalogue_grouping", "idx_catalogue_work_unit",
    ];
    for (const idx of legacyIndexes) db.exec(`DROP INDEX IF EXISTS ${idx};`);
    const legacy = [...LEGACY_IDENTITY_COLUMNS];
    for (const col of legacy) {
      if (hasColumn(db, "catalogue", col)) db.exec(`ALTER TABLE catalogue DROP COLUMN ${col};`);
    }
  }

  if (v < 34) {
    // v34: agent-runtime awareness (salvaged from origin's v5).
    // `substrate` = which agent runtime hosted this session body — null reads as
    // claude-code (the default we've always assumed). Adding this makes the platform
    // honest about hosting non-Claude agents (grok, codex, etc.) later without a schema
    // shift when we do.
    // `identity` = the CLAUDE_IDENTITY env var the launcher exported (a launcher-provenance
    // breadcrumb; distinct from identity_key, which is our post-ADR-0089 durable work-unit
    // key). Useful for attributing a body to which claude-<name> alias started it.
    if (!hasColumn(db, "catalogue", "substrate")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN substrate TEXT;");
    }
    if (!hasColumn(db, "catalogue", "launcher_identity")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN launcher_identity TEXT;");
    }
  }

  if (v < 35) {
    // No backfill: null distinguishes legacy/plain sessions from declared causal intent.
    if (!hasColumn(db, "catalogue", "session_class")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN session_class TEXT CHECK (session_class IN ('work_body', 'auxiliary') OR session_class IS NULL);");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_session_class ON catalogue(session_class);");
  }
  if (v < 36) {
    // The reviewed historical detached-child backfill records a complete managed-field preimage
    // before changing catalogue state. It is intentionally separate from general session metadata:
    // every operation is manifest-pinned and can be inspected or safely reverted later.
    db.exec(`
      CREATE TABLE IF NOT EXISTS historical_detached_child_backfills (
        operation_id TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        reverted_at TEXT,
        snapshot_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_historical_detached_child_backfills_manifest
        ON historical_detached_child_backfills(manifest_sha256);
    `);
  }
  if (v < 37) {
    // Managed session births: creator provenance is independent from causal parentage and class.
    if (!hasColumn(db, "catalogue", "creator_kind")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN creator_kind TEXT CHECK (creator_kind IN ('human', 'agent', 'automation') OR creator_kind IS NULL);");
    }
    if (!hasColumn(db, "catalogue", "creator_ref")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN creator_ref TEXT;");
    }
    if (!hasColumn(db, "catalogue", "launch_channel")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN launch_channel TEXT;");
    }
    if (!hasColumn(db, "catalogue", "forked_from_session_id")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN forked_from_session_id TEXT;");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_creator_kind ON catalogue(creator_kind);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_launch_channel ON catalogue(launch_channel);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_forked_from ON catalogue(forked_from_session_id);");
  }
  if (v < 38) {
    // Session enrichment: one structured inference pass per session, stored as first-class
    // columns rather than a `meta` blob. Columns (not meta) because enrichment is real state that
    // the statusline, `ccs ls`, and external readers all query — meta is explicitly scratch state
    // that ccs stores without interpreting, and this is the opposite of that.
    //
    // No backfill: null enrichment_at means "never enriched", which is exactly what the sweep's
    // staleness check needs to find its first-run candidates.
    for (const [column, type] of [
      ["enrichment_summary", "TEXT"],
      ["enrichment_outstanding", "TEXT"],
      ["enrichment_reason", "TEXT"],
      // Junk = "was never worth starting", kept separate from `archive` so a failed real attempt
      // and an accidental one-line probe stay distinguishable after both are archived.
      ["enrichment_junk", "INTEGER"],
      ["enrichment_cwd_correct", "INTEGER"],
      // A key from the shared location registry. Free-text cwd is the escape hatch for work with
      // no registered home — which is itself the signal that one should be registered.
      ["enrichment_suggested_location", "TEXT"],
      ["enrichment_suggested_cwd", "TEXT"],
      // Message count at generation. Staleness is `current - this`, so the sweep re-runs only
      // sessions that actually advanced rather than everything on a timer.
      ["enrichment_at_messages", "INTEGER"],
      ["enrichment_at", "TEXT"],
      ["enrichment_attempts", "INTEGER"],
    ] as const) {
      if (!hasColumn(db, "catalogue", column)) {
        db.exec(`ALTER TABLE catalogue ADD COLUMN ${column} ${type};`);
      }
    }
    // Constrained separately from the loop above: the CHECK keeps a malformed write out of the
    // column even when it arrives through `ccs session-fields` rather than the enrich command.
    if (!hasColumn(db, "catalogue", "enrichment_recommendation")) {
      db.exec(
        "ALTER TABLE catalogue ADD COLUMN enrichment_recommendation TEXT " +
        "CHECK (enrichment_recommendation IN ('continue', 'complete', 'archive', 'handoff') " +
        "OR enrichment_recommendation IS NULL);",
      );
    }
    // The two queries this feature runs constantly: "what needs my attention" and "what is stale".
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_enrichment_recommendation ON catalogue(enrichment_recommendation);");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_enrichment_at ON catalogue(enrichment_at);");
  }
  if (v < 39) {
    // A title derived from the whole session rather than its opening.
    //
    // Deliberately NOT written to `custom_title`: that column holds a name a human chose, and a
    // model must never quietly overwrite one. Keeping them separate lets the display layer prefer
    // human > enrichment > the pre-session guesses, and makes the enriched title revisable on
    // every pass without ever destroying an authored one.
    if (!hasColumn(db, "catalogue", "enrichment_title")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN enrichment_title TEXT;");
    }
  }
  if (v < 40) {
    // v40 splits both prose fields.
    //
    // `summary` had to be both "where this stands" and "how it got here", and was always written
    // in that order, so the state ended up in the final clause of a paragraph. `outstanding` held
    // a comma-run of several actions in 199 of 371 real rows. Two columns each, because an
    // instruction to lead with the state is one a model can drift from and a column boundary is
    // not.
    //
    // ADDITIVE ONLY. `enrichment_summary` and `enrichment_outstanding` survive this migration and
    // are dropped in v41, after the re-enrich sweep has populated the new columns — the old text
    // is the only copy of these descriptions, so it outlives the schema that replaces it until
    // there is something to replace it WITH.
    for (const [column, type] of [
      ["enrichment_state", "TEXT"],
      ["enrichment_history", "TEXT"],
      ["enrichment_next", "TEXT"],
      ["enrichment_remaining", "TEXT"],
    ] as const) {
      if (!hasColumn(db, "catalogue", column)) {
        db.exec(`ALTER TABLE catalogue ADD COLUMN ${column} ${type};`);
      }
    }
    // No new index. `ccs next` filters on `enrichment_recommendation`, which v38 already indexed,
    // and the store is ~2.4k rows — a partial index over it buys nothing measurable while adding
    // a column that DROP COLUMN then has to route around during a downgrade.
  }
  // Records that a verdict was declined.
  //
  // Without it a dismissed suggestion returns on the next sweep, so declining one is a delay
  // rather than a decision, and a queue that re-fills itself with things you already rejected
  // stops being worth working down.
  //
  // The VERB is stored, not a flag. Enrichment changing its mind is new information: declining
  // `archive` says nothing about a later `complete`, and a boolean would suppress both.
  //
  // Deliberately OUTSIDE the version ladder. v41 is already claimed by the enrichment branch for
  // dropping `enrichment_summary` / `enrichment_outstanding`, and stamping this catalogue past 41
  // here would make that migration's `v < 41` false on Milad's live store — silently skipping a
  // drop that branch believes it performed. Additive, presence-guarded and idempotent, so running
  // it on every open costs one PRAGMA and cannot collide with whatever number that work lands as.
  if (!hasColumn(db, "catalogue", "enrichment_declined")) {
    db.exec("ALTER TABLE catalogue ADD COLUMN enrichment_declined TEXT;");
  }
  // Marks a session the tool must not surface, summarize, or transmit.
  //
  // A COLUMN, not a tag. `session_tags` has no reader in any listing path, so a tag would have to
  // grow a new join at every one of them; `archived` and `session_class` already reach everywhere
  // precisely because they are columns, and `session_class` additionally feeds the pre-computed
  // `catalogue_hidden_sessions` table the whole cross-product protocol reads through.
  //
  // Orthogonal to `session_class` rather than another value of it: a session can legitimately be
  // both `auxiliary` and incognito, and one column cannot say both.
  //
  // Outside the version ladder for the same reason as `enrichment_declined` directly above — v41
  // belongs to the enrichment-column retirement, and stamping past it here would silently skip
  // that migration on the live store.
  if (!hasColumn(db, "catalogue", "incognito")) {
    db.exec("ALTER TABLE catalogue ADD COLUMN incognito INTEGER NOT NULL DEFAULT 0;");
  }
  // Partial: the incognito set is tiny by construction, and every read is "exclude these", so the
  // index only ever needs to enumerate the few rows that are excluded.
  db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_incognito ON catalogue(session_id) WHERE incognito = 1;");

  // Saved is a distinct resumable state. Archive represented terminal discarded work, so existing
  // archived rows fold into Done once; Saved starts empty rather than claiming old discards were kept.
  // This migration has its own line because catalogue user_version 41 is reserved by enrichment.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lifecycle_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const lifecycleSchemaVersion = (db.query(
    "SELECT COALESCE(MAX(version), 0) AS version FROM lifecycle_schema_migrations",
  ).get() as { version: number }).version;
  if (!hasColumn(db, "catalogue", "saved")) {
    db.exec("ALTER TABLE catalogue ADD COLUMN saved INTEGER NOT NULL DEFAULT 0;");
  }
  if (!hasColumn(db, "identities", "saved")) {
    db.exec("ALTER TABLE identities ADD COLUMN saved INTEGER NOT NULL DEFAULT 0;");
  }
  if (lifecycleSchemaVersion < 1) {
    if (hasColumn(db, "catalogue", "completed") && hasColumn(db, "catalogue", "archived")) {
      db.exec("UPDATE catalogue SET completed = 1, archived = 0 WHERE archived = 1;");
    }
    if (hasColumn(db, "identities", "completed") && hasColumn(db, "identities", "archived")) {
      db.exec("UPDATE identities SET completed = 1, archived = 0 WHERE archived = 1;");
    }
    db.exec(`
      INSERT INTO lifecycle_schema_migrations(version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  }

  // Life-domain storage has its own numbered migration line because catalogue user_version 41 is
  // already reserved by the enrichment-column retirement. This keeps category DDL idempotent and
  // observable without skipping that independent migration when it lands.
  db.exec(`
    CREATE TABLE IF NOT EXISTS category_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const categorySchemaVersion = (db.query(
    "SELECT COALESCE(MAX(version), 0) AS version FROM category_schema_migrations",
  ).get() as { version: number }).version;
  if (categorySchemaVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_category_assignments (
        session_id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL,
        classifier_version TEXT NOT NULL,
        classified_at TEXT NOT NULL,
        manual_lock INTEGER NOT NULL DEFAULT 0,
        evidence TEXT,
        failed_write TEXT,
        category_attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_session_category_slug ON session_category_assignments(slug);
      CREATE TABLE IF NOT EXISTS session_category_attempts (
        session_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS category_backfill_audits (
        operation_id TEXT PRIMARY KEY,
        manifest_sha256 TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        reverted_at TEXT,
        snapshot_json TEXT NOT NULL
      );
      INSERT OR IGNORE INTO category_schema_migrations(version, applied_at)
      VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `);
  }
  // Heal the first unnumbered preview schema without treating its presence as a completed migration.
  if (!hasColumn(db, "session_category_assignments", "category_attempts")) {
    db.exec("ALTER TABLE session_category_assignments ADD COLUMN category_attempts INTEGER NOT NULL DEFAULT 0;");
  }
  if (!hasColumn(db, "session_category_assignments", "next_attempt_at")) {
    db.exec("ALTER TABLE session_category_assignments ADD COLUMN next_attempt_at TEXT;");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_category_slug ON session_category_assignments(slug);
    CREATE TABLE IF NOT EXISTS session_category_attempts (
      session_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT
    );
    CREATE TABLE IF NOT EXISTS category_backfill_audits (
      operation_id TEXT PRIMARY KEY,
      manifest_sha256 TEXT NOT NULL,
      manifest_path TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      reverted_at TEXT,
      snapshot_json TEXT NOT NULL
    );
  `);
  if (v !== CATALOGUE_VERSION) db.exec(`PRAGMA user_version = ${CATALOGUE_VERSION};`);
}

/** Reconcile an interrupted column rename by schema presence, not only user_version.
 * Conflicting non-null values are ambiguous evidence, so fail rather than silently choose one. */
function reconcileLegacyRename(
  db: Database,
  legacy: "system" | "epic_id",
  current: "cluster" | "grouping_id",
  ensureCurrent: boolean,
): void {
  const hasLegacy = hasColumn(db, "catalogue", legacy);
  const hasCurrent = hasColumn(db, "catalogue", current);
  if (hasLegacy && !hasCurrent) {
    db.exec(`ALTER TABLE catalogue RENAME COLUMN ${legacy} TO ${current};`);
    return;
  }
  if (hasLegacy && hasCurrent) {
    const conflict = db.query(
      `SELECT session_id FROM catalogue
       WHERE ${legacy} IS NOT NULL AND ${current} IS NOT NULL AND ${legacy} <> ${current}
       LIMIT 1`,
    ).get() as { session_id: string } | null;
    if (conflict) {
      throw new Error(
        `catalogue row ${conflict.session_id} has conflicting ${legacy} and ${current} values`,
      );
    }
    db.exec(
      `UPDATE catalogue SET ${current} = ${legacy}
       WHERE ${current} IS NULL AND ${legacy} IS NOT NULL;`,
    );
    return;
  }
  if (!hasCurrent && ensureCurrent) {
    db.exec(`ALTER TABLE catalogue ADD COLUMN ${current} TEXT;`);
  }
}

function validateCatalogueMeta(db: Database): void {
  const rows = db.query(
    "SELECT session_id, meta FROM catalogue WHERE meta IS NOT NULL",
  ).all() as Array<{ session_id: string; meta: string }>;
  for (const row of rows) parseCatalogueMetaObject(row.meta, row.session_id);
}

function parseCatalogueMetaObject(
  raw: string | null,
  sessionId: string,
): { [key: string]: StoredMetaValue } {
  if (raw === null) return {};
  let parsed: StoredMetaValue;
  try {
    parsed = JSON.parse(raw) as StoredMetaValue;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`catalogue meta for ${sessionId} is malformed JSON: ${detail}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`catalogue meta for ${sessionId} must be a JSON object`);
  }
  return parsed as { [key: string]: StoredMetaValue };
}

/** Preserve identity-shaped values from rows that cannot be attached to an identity before
 * v33 retires the legacy columns. Also retain explicit legacy `key` and `project` values on
 * attached rows: both were user-set, are absent from the identity table, and cannot be rebuilt.
 * The reserved meta object is recovery evidence, not a new identity source of truth. */
function preserveLegacyIdentityEvidence(db: Database): void {
  const present = LEGACY_IDENTITY_COLUMNS.filter((column) => hasColumn(db, "catalogue", column));
  if (present.length === 0) return;
  if (!hasColumn(db, "catalogue", "identity_key") || !hasColumn(db, "catalogue", "meta")) {
    throw new Error("cannot preserve legacy identity data without identity_key and meta columns");
  }

  type LegacyIdentityRow = {
    session_id: string;
    identity_key: string | null;
    meta: string | null;
  } & Record<string, string | number | null>;
  const attachedEvidenceColumns = new Set<string>(
    present.filter((column) => column === "key" || column === "project"),
  );
  const evidenceWhere = [
    "identity_key IS NULL",
    ...[...attachedEvidenceColumns].map((column) => `${column} IS NOT NULL`),
  ].join(" OR ");
  const rows = db.query(
    `SELECT session_id, identity_key, meta, ${present.join(", ")}
     FROM catalogue
     WHERE ${evidenceWhere}`,
  ).all() as LegacyIdentityRow[];
  const update = db.query("UPDATE catalogue SET meta = $meta WHERE session_id = $id");

  for (const row of rows) {
    const legacy: { [key: string]: StoredMetaValue } = {};
    for (const column of present) {
      if (row.identity_key !== null && !attachedEvidenceColumns.has(column)) continue;
      const value = row[column];
      if (value !== null && value !== undefined) legacy[column] = value;
    }
    if (Object.keys(legacy).length === 0) continue;

    const meta = parseCatalogueMetaObject(row.meta, row.session_id);
    const existing = meta[LEGACY_IDENTITY_META_KEY];
    if (existing !== undefined) {
      if (existing === null || Array.isArray(existing) || typeof existing !== "object") {
        throw new Error(`catalogue meta for ${row.session_id} has invalid ${LEGACY_IDENTITY_META_KEY}`);
      }
      const existingLegacy = existing as { [key: string]: StoredMetaValue };
      for (const [key, value] of Object.entries(legacy)) {
        if (
          Object.prototype.hasOwnProperty.call(existingLegacy, key) &&
          existingLegacy[key] !== value
        ) {
          throw new Error(
            `catalogue meta for ${row.session_id} conflicts with live legacy column ${key}`,
          );
        }
      }
      meta[LEGACY_IDENTITY_META_KEY] = { ...existingLegacy, ...legacy };
    } else {
      meta[LEGACY_IDENTITY_META_KEY] = legacy;
    }
    update.run({ $meta: JSON.stringify(meta), $id: row.session_id });
  }
}

function hasTable(db: Database, table: string): boolean {
  return db.query(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $name",
  ).get({ $name: table }) !== null;
}

/** Whether a table already has a given column (PRAGMA table_info), for idempotent ALTERs. */
export function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

// --- roles registry (ADR-0022) -------------------------------------------------

/** A role DEFINITION: its runtime wiring + what to materialize into ~/.claude. */
/** A role's work-unit anchor type (ADR-0069): what shape of work-unit the role owns, and how a
 * work-unit reconnects across sessions. `none` ⇒ the role owns no work-unit ⇒ it is CORE; anything
 * else ⇒ FLEET. `pr`/`gus` reconnect by that anchor attribute; `freeform` is a ccs-minted id only. */
export type WorkUnitAnchorType = "pr" | "gus" | "freeform" | "none";

/** Role-declared schema for the blessed `stage` column (ADR-0064): the allowed vocabulary and
 * whether the stage is monotonic (forward-only). The tool ENFORCES these guarantees; the cluster
 * OWNS the vocabulary (the ADR-0061 split). Absent = no constraint (the setter stores any string). */
export interface StageSchema {
  /** Allowed stage values, in monotonic order (index = rank). Empty/absent = unconstrained. */
  values: string[];
  /** When true, a stage may only move forward (to an equal-or-higher rank in `values`). */
  monotonic: boolean;
}

export interface RoleDef {
  role: string;
  /** Optional cluster grouping (nullable — a role can stand alone, ADR-0022). */
  cluster: string | null;
  kind: Kind | null;
  /** Declared work-unit anchor type (ADR-0069): what shape of work-unit this role owns. Fleet-ness
   * derives from it — `none` ⇒ core, anything else ⇒ fleet (subsumes the interim ADR-0062
   * `topology`). Nullable when role.toml declares neither `work_unit` nor `topology`. */
  workUnit: WorkUnitAnchorType | null;
  /** Where sessions of this role spawn (permission/statusLine scope, ADR-0018/0036). */
  homeDir: string | null;
  /** How a loop role is re-armed on resume (ADR-0015); null for non-loop roles. */
  resumeCommand: string | null;
  /** Role-declared schema for the `stage` column (ADR-0064): allowed values + monotonic guarantee.
   * null when role.toml declares no [stage] block (the setter stays unconstrained). */
  stageSchema: StageSchema | null;
  /** When true, `ccs resume-cluster` pins this role's cmux workspace after resume — control-plane /
   * concierge / eval / … stay put at the top of the sidebar even as fleet workers churn. Opt-in per
   * role (role.toml `pin_on_resume = true`); default false (fleet workers stay unpinned). */
  pinOnResume: boolean;
  /** Role's accent color as a 7-char hex string (`#RRGGBB`), the ONE source of truth that powers
   * both the ccs role column (TUI) AND the cmux workspace tab color. Declared in role.toml
   * (`color = "#7d7dff"`); null when no color is set (TUI falls back to faint, cmux-paint to
   * whatever it declares). Kept as hex so ccs and cmux render literally identical bytes. */
  color: string | null;
  /** Optional canonical model policy authored in role.toml; launch routing is derived from it. */
  model: import("../resume/role-model-launch.ts").RoleModelId | null;
  /** Claude Code operating posture to re-assert on every birth and resume; null when undeclared. */
  permissionMode: string | null;
  /** A malformed manifest/model/permission policy is observable and blocks a fresh birth. */
  manifestError: string | null;
  /** Skills / commands / hooks to materialize into ~/.claude for this role (ADR-0034). */
  skills: string[];
  commands: string[];
  hooks: string[];
  updatedAt: string | null;
}

// Role DEFINITIONS are read from config FILES now (ADR-0048/0050), not a sqlite table — see
// src/roles/role-files.ts. The `RoleDef` type stays (shared shape); the `roles` table + its
// accessors were removed. The `roles` table is dropped in the migration below.

export interface HistoricalDetachedChildBackfillAudit {
  readonly operationId: string;
  readonly manifestSha256: string;
  readonly manifestPath: string;
  readonly appliedAt: string;
  readonly revertedAt: string | null;
  readonly snapshotJson: string;
}
