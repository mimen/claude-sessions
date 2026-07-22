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
  parkedTaskId: string | null;
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

const CATALOGUE_VERSION = 37;

export function openCatalogue(
  dbPath: string,
  options: { readonly materialize?: boolean } = {},
): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  // ADR-D4 / B15 (2026-07-14): after migrations claim to have completed, sanity-check the
  // schema shape before returning the db to callers. If a migration was presence-driven and
  // its guard was false (e.g. both an old + new column present because the DB was
  // hand-patched), we could stamp `user_version` current with a wrong shape. Catch it here.
  const post = validateSchemaPostcondition(db);
  if (!post.ok) {
    // Loud + fatal: a corrupt schema surfaced this way is worse to hide. The caller (ccs cli)
    // exits, the operator investigates. Fresh-DB path is guaranteed to pass because the v1
    // migration creates every required column.
    throw new Error(`catalogue schema postcondition failed: ${post.error}`);
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
    // Keeping this lazy makes db.ts safe to import from anywhere.
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

/** After migrate() has stamped user_version=CATALOGUE_VERSION, verify the actual schema
 * matches. Presence-driven migrations can skip an ALTER when a hand-patched DB already has
 * both old + new column names — the version stamp then lies. This function checks:
 *   - required columns exist
 *   - no known legacy column is present alongside its replacement (would indicate a skipped
 *     rename)
 * Returns ok on success or { ok: false, error } on any deviation. */
function validateSchemaPostcondition(db: Database): { ok: true } | { ok: false; error: string } {
  // ADR-0089 v33: identity attrs moved to identities + identity_<role> tables. Catalogue
  // holds only per-run session state now.
  const required = [
    "session_id",
    "identity_key",
    "meta",
    "updated_at",
    "session_class",
    "creator_kind",
    "creator_ref",
    "launch_channel",
    "forked_from_session_id",
  ];
  const forbidden_pairs = [
    // ADR-0059 renamed system → cluster; both should never coexist.
    ["system", "cluster"],
    // ADR-0070 renamed epic_id → grouping_id; both should never coexist.
    ["epic_id", "grouping_id"],
  ] as const;
  const cols = (db.query("PRAGMA table_info(catalogue)").all() as { name: string }[]).map((c) => c.name);
  const present = new Set(cols);
  const missing = required.filter((c) => !present.has(c));
  if (missing.length > 0) {
    return { ok: false, error: `catalogue missing required column(s): ${missing.join(", ")}` };
  }
  for (const [legacy, current] of forbidden_pairs) {
    if (present.has(legacy) && present.has(current)) {
      return { ok: false, error: `catalogue has BOTH legacy "${legacy}" and current "${current}" — a rename migration was skipped` };
    }
  }
  return { ok: true };
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
    if (hasColumn(db, "catalogue", "milad_review") || hasColumn(db, "catalogue", "build_complete")) {
      const rows = db.query("SELECT session_id, milad_review, build_complete, meta FROM catalogue").all() as Array<{
        session_id: string;
        milad_review: string | null;
        build_complete: number | null;
        meta: string | null;
      }>;
      const update = db.prepare("UPDATE catalogue SET meta = ? WHERE session_id = ?");
      for (const r of rows) {
        const meta = r.meta ? JSON.parse(r.meta) : {};
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
  if (v < 27) {
    // ADR-0059: rename the `system` column to `cluster` everywhere — the operation-level grouping
    // is **cluster** in all UI/CLI/docs, so make the DB column match. SQLite 3.25+ supports RENAME COLUMN.
    // Guard on column presence (older binary can reset version, re-run).
    if (hasColumn(db, "catalogue", "system") && !hasColumn(db, "catalogue", "cluster")) {
      db.exec("ALTER TABLE catalogue RENAME COLUMN system TO cluster;");
    } else if (!hasColumn(db, "catalogue", "cluster")) {
      // Some legacy v5 catalogues advanced user_version without ever receiving the v5
      // `system` column. Add the renamed column directly so later migrations can read it.
      db.exec("ALTER TABLE catalogue ADD COLUMN cluster TEXT;");
    }
    db.exec("DROP INDEX IF EXISTS idx_catalogue_system;");
    db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_cluster ON catalogue(cluster);");
  }
  if (v < 28) {
    // ADR-0070: rename the `epic_id` FK column to `grouping_id` — "grouping" is the generic
    // platform concept and "epic" is pr-watch's declared grouping TYPE (cluster.toml grouping_type),
    // so the column shouldn't hardcode the type. SQLite 3.25+ supports RENAME COLUMN. Guard on
    // column presence (older binary can reset version, re-run). Same shape as the v27 rename.
    if (hasColumn(db, "catalogue", "epic_id") && !hasColumn(db, "catalogue", "grouping_id")) {
      db.exec("ALTER TABLE catalogue RENAME COLUMN epic_id TO grouping_id;");
      db.exec("DROP INDEX IF EXISTS idx_catalogue_epic;");
      db.exec("CREATE INDEX IF NOT EXISTS idx_catalogue_grouping ON catalogue(grouping_id);");
    }
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
  if (v < 31) {
    // A few legacy catalogues carried user_version 27–30 without either side of the
    // system→cluster rename. v31 reads cluster during its key backfill, so repair that
    // invariant here too before selecting rows; v33 removes the legacy identity column.
    if (!hasColumn(db, "catalogue", "cluster")) {
      db.exec("ALTER TABLE catalogue ADD COLUMN cluster TEXT;");
    }
    // ADR-D1 (2026-07-14): ccs is the single source of truth for the identity KEY. Historically
    // `key` was populated only by explicit setKey() calls (new-session, key command), so many
    // rows had a null key even though their pr_repo+pr_number/gus_work/role columns implied one.
    // Cluster engines (compose_board.py) re-derived the key locally and drifted. Backfill:
    // compute deriveKey() for every row that lacks a key, populate. From v31 forward every
    // identity-affecting mutator calls refreshDerivedKey() so the column stays authoritative.
    const rows = db.query(
      `SELECT session_id, key, role, cluster, pr_repo, pr_number, gus_work, work_unit_id
       FROM catalogue`,
    ).all() as Array<{
      session_id: string;
      key: string | null;
      role: string | null;
      cluster: string | null;
      pr_repo: string | null;
      pr_number: number | null;
      gus_work: string | null;
      work_unit_id: string | null;
    }>;
    const nowIso = new Date().toISOString();
    const upd = db.query(
      "UPDATE catalogue SET key = $k, updated_at = $now WHERE session_id = $id",
    );
    for (const r of rows) {
      const derived = deriveKey({
        workUnitId: r.work_unit_id,
        prRepo: r.pr_repo,
        prNumber: r.pr_number,
        gusWork: r.gus_work,
        role: r.role,
      });
      if (derived && r.key !== derived) {
        upd.run({ $k: derived, $now: nowIso, $id: r.session_id });
      }
    }
  }
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

  if (v < 32) {
    // Backfill identities from catalogue rows. For each row that has enough info to identify
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
      completed: number;
      archived: number;
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
        $c: r.completed,
        $a: r.archived,
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
    const legacyIndexes = [
      "idx_catalogue_event", "idx_catalogue_project", "idx_catalogue_role", "idx_catalogue_system",
      "idx_catalogue_cluster", "idx_catalogue_pr_number", "idx_catalogue_pr_repo",
      "idx_catalogue_key", "idx_catalogue_gus_work", "idx_catalogue_epic",
      "idx_catalogue_grouping", "idx_catalogue_work_unit",
    ];
    for (const idx of legacyIndexes) db.exec(`DROP INDEX IF EXISTS ${idx};`);
    const legacy = [
      "role", "cluster", "project", "event",
      "pr_number", "pr_repo", "pr_branch", "pr_state", "pr_head_sha",
      "gus_work", "work_unit_id", "epic_id", "grouping_id",
      "key", "stage", "status_line",
    ];
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
  if (v !== CATALOGUE_VERSION) db.exec(`PRAGMA user_version = ${CATALOGUE_VERSION};`);
}

/** Whether a table already has a given column (PRAGMA table_info), for idempotent ALTERs. */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** (cluster, role) → resume_command (or null), memoized. ADR-D3 (2026-07-14): key by
 * (cluster,role), not just role — two clusters with the same role name would collide otherwise
 * (a live P0 risk before this change). A null cluster is the standalone bucket.
 * Cached because rowFrom runs per-row in getAll (hot path); role defs are static within a
 * process. Lazy require avoids a load-time cycle. */
let roleResumeCache: Map<string, string | null> | null = null;
/** Reset the memo. For tests that swap CCS_CONFIG_ROOT between cases. */
export function _resetRoleResumeCache(): void {
  roleResumeCache = null;
}
function roleResumeCommand(role: string | null, cluster: string | null): string | null {
  if (!role) return null;
  if (!roleResumeCache) roleResumeCache = new Map();
  const cacheKey = `${cluster ?? ""}␟${role}`;
  if (roleResumeCache.has(cacheKey)) return roleResumeCache.get(cacheKey)!;
  let rc: string | null = null;
  try {
    // Lazy import to keep db.ts free of a load-time dependency on role-files.
    rc = (require("../roles/role-files.ts") as typeof import("../roles/role-files.ts"))
      .resolveRole(role, cluster)?.resumeCommand ?? null;
  } catch {
    rc = null;
  }
  roleResumeCache.set(cacheKey, rc);
  return rc;
}

/**
 * Build a CatalogueRow from a raw catalogue row. Post-ADR-0089 v33, the identity-relevant
 * fields live on the `identities` table (universal) and `identity_<role>` (per-fleet-role
 * attrs). We join them here so consumers see one flat row regardless of what's stored where.
 *
 * `db` is optional so pure-in-memory tests without an identity table still work — they get
 * null for every identity field, which is the correct answer for a loose synthetic row.
 */
function rowFrom(r: Record<string, unknown> | null, db?: Database): CatalogueRow | null {
  if (!r) return null;
  const identityKey = (r.identity_key as string) ?? null;
  let idRow: Record<string, unknown> | null = null;
  let idAttrs: Record<string, unknown> = {};
  if (identityKey && db) {
    try {
      idRow = db.query("SELECT * FROM identities WHERE identity_key = $k").get({
        $k: identityKey,
      }) as Record<string, unknown> | null;
      if (idRow?.role) {
        const table = `identity_${(idRow.role as string).replace(/-/g, "_")}`;
        try {
          const attrs = db.query(`SELECT * FROM ${table} WHERE identity_key = $k`).get({
            $k: identityKey,
          }) as Record<string, unknown> | null;
          if (attrs) idAttrs = attrs;
        } catch {
          /* core identity has no per-role table */
        }
      }
    } catch {
      /* identities table not present (tests without full schema) — fall through */
    }
  }
  const role = (idRow?.role as string) ?? null;
  const cluster = (idRow?.cluster as string) ?? null;
  const resumeCommand = roleResumeCommand(role, cluster);
  const idMeta =
    typeof idRow?.meta === "string" ? (JSON.parse(idRow.meta) as Record<string, unknown>) : {};
  const sessionMeta = r.meta ? JSON.parse(r.meta as string) : {};
  return {
    sessionId: r.session_id as string,
    resumeId: (r.resume_id as string) ?? null,
    customTitle: (r.custom_title as string) ?? null,
    kind: resumeCommand ? "loop" : "session",
    // Lifecycle lives on the identity (identity-level retirement cascades to all attached
    // sessions). For loose sessions with no identity, the flags stayed on catalogue during
    // migration; we look at both to be defensive.
    // Prefer session-scoped catalogue value when non-default; falls back to identity for
    // rows minted via `ccs identity complete/archive` where the catalogue row wasn't touched.
    completed: !!(r.completed || idRow?.completed),
    archived: !!(r.archived || idRow?.archived),
    parkedTaskId: (r.parked_task_id as string) ?? (idRow?.parked_task_id as string) ?? null,
    // Legacy `key` field — mapped to the same value as identityKey for API-stable consumers.
    key: identityKey,
    parentSessionId: (r.parent_session_id as string) ?? null,
    sessionClass: (r.session_class as SessionClass) ?? null,
    creatorKind: (r.creator_kind as CreatorKind) ?? null,
    creatorRef: (r.creator_ref as string) ?? null,
    launchChannel: (r.launch_channel as LaunchChannel) ?? null,
    forkedFromSessionId: (r.forked_from_session_id as string) ?? null,
    role,
    resumeCommand,
    project: null,  // dropped in v33 (unused post-refactor)
    cluster,
    gusWork: (idAttrs.gus_work as string) ?? null,
    workUnitId: null,  // dropped in v33 (identity_key supersedes it)
    groupingId: (idRow?.grouping_id as string) ?? null,
    stage: (idRow?.stage as string) ?? null,
    statusLine: (idRow?.status_line as string) ?? null,
    // Both meta maps flow through — identity meta first, session meta overlays.
    meta: { ...idMeta, ...sessionMeta },
    notes: (r.notes as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
    prNumber: (idAttrs.pr_number as number) ?? null,
    prRepo: (idAttrs.pr_repo as string) ?? null,
    prBranch: (idAttrs.pr_branch as string) ?? null,
    prState: (idAttrs.pr_state as PrState) ?? null,
    prHeadSha: (idAttrs.pr_head_sha as string) ?? null,
    identityKey,
    substrate: (r.substrate as string) ?? null,
    launcherIdentity: (r.launcher_identity as string) ?? null,
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
    db,
  );
}

/** All catalogue rows keyed by session_id, for joining against the Index in one pass. */
export function getAll(db: Database): Map<string, CatalogueRow> {
  const rows = db.query("SELECT * FROM catalogue").all() as Record<string, unknown>[];
  const map = new Map<string, CatalogueRow>();
  for (const r of rows) {
    const row = rowFrom(r, db);
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
 * Pure: the canonical identity key for system-level grouping. ADR-D1 (2026-07-14): ccs is the
 * SINGLE SOURCE OF TRUTH — the `key` column is auto-derived on every mutation that touches an
 * identity-relevant field (see `deriveKey`), so `row.key` is authoritative and no consumer (TS
 * or Python engine) ever re-derives. Historical bug: three parallel implementations (lineage.ts,
 * db.ts, compose_board.py) drifted; centralizing derivation kills the drift class at the root.
 */
export function identityKeyOf(row: CatalogueRow | null): string | null {
  if (!row) return null;
  // ADR-0089: prefer the new structured identity_key (<cluster>:<role>:<work_ref>) when the
  // row carries one. The legacy `key` column (`pr:owner/repo#12345` shape) is kept as a
  // fallback for synthetic rows built by tests or for pre-v32-backfill rows in unusual DB
  // states. The fallback goes away when the legacy `key` column drops (step 12).
  return row.identityKey ?? row.key;
}

/**
 * Pure: derive the identity key from a row's identity-relevant columns. This is the ONE
 * implementation — TS callers use this; the engine reads the stored `key` column. Priority
 * mirrors `lineage.identityKey`: work-unit id → PR key → GUS key → role fallback → null.
 * Exported for tests + the identity-resolve CLI.
 */
export function deriveKey(row: {
  workUnitId?: string | null;
  prRepo?: string | null;
  prNumber?: number | null;
  gusWork?: string | null;
  role?: string | null;
}): string | null {
  if (row.workUnitId) return `wu:${row.workUnitId}`;
  if (row.prRepo && row.prNumber != null) return `pr:${row.prRepo}#${row.prNumber}`;
  if (row.gusWork) return `gus:${row.gusWork}`;
  if (row.role) return `role:${row.role}`;
  return null;
}

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

/**
 * Re-derive and persist the `key` column from the row's current identity-relevant columns.
 * Called after every mutation that touches role / cluster / prRepo / prNumber / gusWork /
 * workUnitId. If the derived key differs from the stored one, updates in place; otherwise
 * a no-op. Never blanks a key set by an explicit `setKey` (freeform anchor) — those are
 * preserved when nothing else derives.
 */
function refreshDerivedKey(db: Database, sessionId: string, now: string): void {
  // ADR-0089 v33: legacy `key` column dropped. Callers that trailed this (setRole,
  // setCluster, setGusWork, setWorkUnitId) now no-op — identity_key is set explicitly at
  // spawn (ccs new-session) and by sensors, never derived from the session's row.
  if (!hasColumn(db, "catalogue", "key")) return;
  const row = getRow(db, sessionId);
  if (!row) return;
  const derived = deriveKey(row);
  if (derived === null) return;
  if (row.key === derived) return;
  db.query("UPDATE catalogue SET key = $k, updated_at = $now WHERE session_id = $id").run({
    $k: derived,
    $now: now,
    $id: sessionId,
  });
}

// ---- mutations (all stamp updated_at; all upsert the row) ----

function set(db: Database, sessionId: string, col: string, value: unknown, now: string): void {
  ensureRow(db, sessionId, now);
  // ADR-0089 v33: legacy per-session identity columns are gone. The mirror in commands.ts
  // routes writes to the identity table (the authoritative store). Set-to-a-dropped-column
  // becomes a no-op that still stamps updated_at.
  if (!hasColumn(db, "catalogue", col)) {
    db.query("UPDATE catalogue SET updated_at = $now WHERE session_id = $id").run({
      $now: now,
      $id: sessionId,
    });
    return;
  }
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
export function setParent(db: Database, sessionId: string, parentId: string | null, now: string): void {
  set(db, sessionId, "parent_session_id", parentId, now);
}
export function setSessionClass(db: Database, sessionId: string, value: SessionClass | null, now: string): void {
  set(db, sessionId, "session_class", value, now);
}
export function setCreatorKind(db: Database, sessionId: string, value: CreatorKind | null, now: string): void {
  set(db, sessionId, "creator_kind", value, now);
}
export function setCreatorRef(db: Database, sessionId: string, value: string | null, now: string): void {
  set(db, sessionId, "creator_ref", value, now);
}
export function setLaunchChannel(db: Database, sessionId: string, value: LaunchChannel | null, now: string): void {
  set(db, sessionId, "launch_channel", value, now);
}
export function setForkedFromSessionId(db: Database, sessionId: string, value: string | null, now: string): void {
  set(db, sessionId, "forked_from_session_id", value, now);
}
export function setLauncherIdentity(db: Database, sessionId: string, value: string | null, now: string): void {
  set(db, sessionId, "launcher_identity", value, now);
}
/** Set the session's ROLE (ADR-0015) — the canonical identity axis. */
export function setRole(db: Database, sessionId: string, role: string | null, now: string): void {
  set(db, sessionId, "role", role, now);
  refreshDerivedKey(db, sessionId, now);
}
export function setProject(db: Database, sessionId: string, project: string | null, now: string): void {
  set(db, sessionId, "project", project, now);
}
export function setCluster(db: Database, sessionId: string, cluster: string | null, now: string): void {
  set(db, sessionId, "cluster", cluster, now);
}
export function setGusWork(db: Database, sessionId: string, gusWork: string | null, now: string): void {
  set(db, sessionId, "gus_work", gusWork, now);
  refreshDerivedKey(db, sessionId, now);
}
/** Set the session's work-unit FK (ADR-0057) — the work-unit entity it belongs to. */
export function setWorkUnitId(db: Database, sessionId: string, workUnitId: string | null, now: string): void {
  set(db, sessionId, "work_unit_id", workUnitId, now);
  refreshDerivedKey(db, sessionId, now);
}
/** The PR stage (building|milad-review|in-review|approved|merged). Engine-latched; forward-only. */
export function setStage(db: Database, sessionId: string, stage: string | null, now: string): void {
  set(db, sessionId, "stage", stage, now);
}

/** A short freeform status a session writes about itself (≤2 lines on its tab). null clears it. */
export function setStatusLine(db: Database, sessionId: string, statusLine: string | null, now: string): void {
  set(db, sessionId, "status_line", statusLine, now);
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

/** Reverse lookup: which sessions are working this GUS work item.
 * ADR-0089 v33: gus_work is a per-role identity attr; joins through identity_<role>. */
export function sessionsForGusWork(db: Database, gusWork: string): string[] {
  return (
    db.query(
      `SELECT c.session_id FROM catalogue c
       JOIN identity_pr_agent p ON p.identity_key = c.identity_key
       WHERE p.gus_work = $g`,
    ).all({ $g: gusWork }) as { session_id: string }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: which sessions belong to this work-unit (ADR-0057).
 * ADR-0089 v33: work_unit_id was folded into identity_key, so this returns sessions whose
 * identity_key matches the passed value (callers should just pass identity_key directly). */
export function sessionsForWorkUnit(db: Database, workUnitId: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE identity_key = $k").all({ $k: workUnitId }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: sessions assigned to a role (the canonical identity axis, ADR-0015). */
// MRU order (ADR-0073): identity→session lookups return most-recently-used first (updated_at
// DESC, NULLs last, sessionId as a stable tiebreak) so resume deterministically reaches for the
// FRESHEST embodiment of an identity, not an arbitrary one. This is what makes tolerating a
// duplicate embodiment safe — the next resume collapses toward the active session.
const MRU_ORDER = "ORDER BY updated_at DESC NULLS LAST, session_id";

export function sessionsForRole(db: Database, role: string): string[] {
  return (
    db.query(
      `SELECT c.session_id FROM catalogue c
       JOIN identities i ON i.identity_key = c.identity_key
       WHERE i.role = $r ${MRU_ORDER.replace("updated_at", "c.updated_at").replace("session_id", "c.session_id")}`,
    ).all({ $r: role }) as { session_id: string }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: sessions on a PR. Repo optional — `#123` matches the number across repos. */
export function sessionsForPr(db: Database, prNumber: number, prRepo?: string): string[] {
  const order = MRU_ORDER.replace("updated_at", "c.updated_at").replace("session_id", "c.session_id");
  const rows = prRepo
    ? (db
        .query(
          `SELECT c.session_id FROM catalogue c
           JOIN identity_pr_agent p ON p.identity_key = c.identity_key
           WHERE p.pr_number = $n AND p.pr_repo = $repo ${order}`,
        )
        .all({ $n: prNumber, $repo: prRepo }) as { session_id: string }[])
    : (db
        .query(
          `SELECT c.session_id FROM catalogue c
           JOIN identity_pr_agent p ON p.identity_key = c.identity_key
           WHERE p.pr_number = $n ${order}`,
        )
        .all({ $n: prNumber }) as { session_id: string }[]);
  return rows.map((r) => r.session_id);
}

// ---- Grouping axis ------------------------------------------------------
// `grouping_id` on a session is a GENERIC grouping FK (ADR-0051/0070). The grouping's DISPLAY
// metadata (name/link/shortname) + notes are CLUSTER RUNTIME state (src/state/groupings.ts),
// written by the cluster's adapter — NOT a hardcoded platform `epics` table (dropped, v15). The
// grouping TYPE (epic/milestone/…) is the cluster's declared vocabulary (ADR-0070), not the
// column's. `epic` remains pr-watch's grouping-type word at the CLI surface (ccs epic / --epic).

/** Point a session at its grouping (the grouping_id FK). null clears it. */
export function setSessionEpic(db: Database, sessionId: string, groupingId: string | null, now: string): void {
  set(db, sessionId, "grouping_id", groupingId, now);
}

/** Reverse lookup: sessions belonging to a grouping. Joins through identities post-ADR-0089. */
export function sessionsForEpic(db: Database, groupingId: string): string[] {
  return (
    db.query(
      `SELECT c.session_id FROM catalogue c
       JOIN identities i ON i.identity_key = c.identity_key
       WHERE i.grouping_id = $g`,
    ).all({ $g: groupingId }) as { session_id: string }[]
  ).map((r) => r.session_id);
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
  /** Skills / commands / hooks to materialize into ~/.claude for this role (ADR-0034). */
  skills: string[];
  commands: string[];
  hooks: string[];
  updatedAt: string | null;
}

// Role DEFINITIONS are read from config FILES now (ADR-0048/0050), not a sqlite table — see
// src/roles/role-files.ts. The `RoleDef` type stays (shared shape); the `roles` table + its
// accessors were removed. The `roles` table is dropped in the migration below.

/** Stamp PR facts. ADR-0089 v33: the pr_* columns are gone from catalogue — this shim
 * now routes to identity_pr_agent via the session's identity_key. If the session isn't
 * yet attached to an identity, we can't stamp (no work-ref to derive one from); the
 * caller must call this after linking. */
export function stampPrFacts(
  db: Database,
  sessionId: string,
  facts: PrFacts | null,
  now: string,
): void {
  ensureRow(db, sessionId, now);
  // If catalogue still has the pr_* columns (pre-v33 test DB or transitional state), write
  // there for backward compat. Otherwise route to identity_pr_agent.
  if (hasColumn(db, "catalogue", "pr_number")) {
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
    refreshDerivedKey(db, sessionId, now);
    return;
  }
  // Post-v33: no pr_* columns on catalogue. Route to identity_pr_agent via the FK.
  const row = db.query("SELECT identity_key FROM catalogue WHERE session_id = $sid").get({
    $sid: sessionId,
  }) as { identity_key: string | null } | null;
  const identityKey = row?.identity_key;
  if (!identityKey) return; // no identity → nowhere to stamp
  try {
    if (facts === null) {
      db.query(
        `UPDATE identity_pr_agent
         SET pr_number = NULL, pr_repo = NULL, pr_branch = NULL, pr_state = NULL, pr_head_sha = NULL,
             updated_at = $now
         WHERE identity_key = $k`,
      ).run({ $now: now, $k: identityKey });
    } else {
      db.query(
        `INSERT INTO identity_pr_agent (identity_key, pr_number, pr_repo, pr_branch, pr_state, pr_head_sha, updated_at)
         VALUES ($k, $num, $repo, $branch, $state, $sha, $now)
         ON CONFLICT(identity_key) DO UPDATE SET
           pr_number = excluded.pr_number,
           pr_repo   = excluded.pr_repo,
           pr_branch = excluded.pr_branch,
           pr_state  = excluded.pr_state,
           pr_head_sha = excluded.pr_head_sha,
           updated_at = excluded.updated_at`,
      ).run({
        $k: identityKey,
        $num: facts.prNumber,
        $repo: facts.prRepo,
        $branch: facts.prBranch,
        $state: facts.prState,
        $sha: facts.prHeadSha,
        $now: now,
      });
    }
    db.query("UPDATE catalogue SET updated_at = $now WHERE session_id = $sid").run({
      $now: now,
      $sid: sessionId,
    });
  } catch {
    // identity_pr_agent absent (materialization skipped in isolated tests) — non-fatal
  }
}

/** Reverse lookup: which sessions are assigned to this identity_key. Post-ADR-0089 v33
 * the legacy `key` column is gone; this now queries the FK directly. */
export function sessionsForKey(db: Database, key: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE identity_key = $k").all({ $k: key }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: which sessions are assigned to this project label.
 * ADR-0089 v33: project column dropped; nothing tracks it anymore. Returns []. */
export function sessionsForProject(_db: Database, _project: string): string[] {
  return [];
}

/** Reverse lookup: which sessions belong to this cluster (via identity join). */
export function sessionsForCluster(db: Database, cluster: string): string[] {
  return (
    db.query(
      `SELECT c.session_id FROM catalogue c
       JOIN identities i ON i.identity_key = c.identity_key
       WHERE i.cluster = $c ${MRU_ORDER.replace("updated_at", "c.updated_at").replace("session_id", "c.session_id")}`,
    ).all({ $c: cluster }) as { session_id: string }[]
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

export interface HistoricalDetachedChildBackfillAudit {
  readonly operationId: string;
  readonly manifestSha256: string;
  readonly manifestPath: string;
  readonly appliedAt: string;
  readonly revertedAt: string | null;
  readonly snapshotJson: string;
}

/** Persist one exact-manifest backfill preimage inside the same transaction as its mutations. */
export function createHistoricalDetachedChildBackfillAudit(
  db: Database,
  audit: Omit<HistoricalDetachedChildBackfillAudit, "revertedAt">,
): void {
  db.query(
    `INSERT INTO historical_detached_child_backfills
      (operation_id, manifest_sha256, manifest_path, applied_at, snapshot_json)
     VALUES ($operationId, $manifestSha256, $manifestPath, $appliedAt, $snapshotJson)`,
  ).run({
    $operationId: audit.operationId,
    $manifestSha256: audit.manifestSha256,
    $manifestPath: audit.manifestPath,
    $appliedAt: audit.appliedAt,
    $snapshotJson: audit.snapshotJson,
  });
}

/** Read one historical exact-backfill audit record for verification or rollback. */
export function getHistoricalDetachedChildBackfillAudit(
  db: Database,
  operationId: string,
): HistoricalDetachedChildBackfillAudit | null {
  const row = db.query(
    `SELECT operation_id, manifest_sha256, manifest_path, applied_at, reverted_at, snapshot_json
       FROM historical_detached_child_backfills
      WHERE operation_id = $operationId`,
  ).get({ $operationId: operationId }) as {
    operation_id: string;
    manifest_sha256: string;
    manifest_path: string;
    applied_at: string;
    reverted_at: string | null;
    snapshot_json: string;
  } | null;
  if (row === null) return null;
  return {
    operationId: row.operation_id,
    manifestSha256: row.manifest_sha256,
    manifestPath: row.manifest_path,
    appliedAt: row.applied_at,
    revertedAt: row.reverted_at,
    snapshotJson: row.snapshot_json,
  };
}

/** Mark a historical exact-backfill audit record reverted after its managed fields are restored. */
export function markHistoricalDetachedChildBackfillReverted(
  db: Database,
  operationId: string,
  revertedAt: string,
): void {
  db.query(
    `UPDATE historical_detached_child_backfills
        SET reverted_at = $revertedAt
      WHERE operation_id = $operationId`,
  ).run({ $operationId: operationId, $revertedAt: revertedAt });
}

/**
 * Remove the empty catalogue placeholder created for an indexed historical child that had no
 * pre-existing catalogue row. This intentionally cannot remove a session with any independently
 * authored metadata or tag; callers run it inside their rollback transaction.
 */
export function deleteHistoricalDetachedChildBackfillPlaceholder(db: Database, sessionId: string): void {
  const tags = db.query("SELECT COUNT(*) AS count FROM session_tags WHERE session_id = $id").get({
    $id: sessionId,
  }) as { count: number };
  if (tags.count !== 0) throw new Error(`refusing to delete ${sessionId}: tags remain after rollback`);
  const result = db.query(
    `DELETE FROM catalogue
      WHERE session_id = $id
        AND resume_id IS NULL
        AND custom_title IS NULL
        AND completed = 0
        AND archived = 0
        AND parked_task_id IS NULL
        AND notes IS NULL
        AND identity_key IS NULL
        AND substrate IS NULL
        AND launcher_identity IS NULL
        AND session_class IS NULL
        AND parent_session_id IS NULL
        AND (meta IS NULL OR meta = '{}')`,
  ).run({ $id: sessionId });
  if (result.changes !== 1) {
    throw new Error(`refusing to delete ${sessionId}: row contains state beyond the historical backfill`);
  }
}

/** Reverse lookup: which sessions are tagged with this entity. */
export function sessionsForEntity(db: Database, entity: string): string[] {
  return (
    db.query("SELECT session_id FROM session_tags WHERE entity = $e").all({ $e: entity }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}
