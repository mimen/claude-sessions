import type { Database } from "bun:sqlite";
import { hydrateStoredEnrichment, type StoredEnrichment } from "./enrichment.ts";
import type {
  CatalogueRow,
  CreatorKind,
  HistoricalDetachedChildBackfillAudit,
  LaunchChannel,
  Lifecycle,
  PrState,
  SessionClass,
} from "./db-schema.ts";

export { deriveIdentityKey } from "./db-schema.ts";

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
    // Lazy import to keep db-queries.ts free of a load-time dependency on role-files.
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
    saved: !!(r.saved || idRow?.saved),
    parkedTaskId: (r.parked_task_id as string) ?? (idRow?.parked_task_id as string) ?? null,
    // Session-scoped only, deliberately: incognito is a property of one conversation's content,
    // not of the durable work-item an identity represents, so it never inherits from the identity
    // the way lifecycle above does.
    incognito: !!r.incognito,
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
    enrichment: enrichmentFrom(r),
    enrichmentAttempts: (r.enrichment_attempts as number) ?? 0,
  };
}

/**
 * Hydrate the v38 enrichment columns, or null when the session has never been enriched.
 *
 * `enrichment_at` is the presence key rather than, say, the summary: it is written in the same
 * statement as everything else, so a row that has it has all of it, and a pre-v38 row (or a row
 * whose columns exist but were never written) reads as null instead of a half-built object.
 */
function enrichmentFrom(r: Record<string, unknown>): StoredEnrichment | null {
  // Full catalogue ownership keeps its historical presence key: rows without enrichment_at were
  // never atomically written by setEnrichment and remain absent here, even if optional prose exists.
  if (typeof r.enrichment_at !== "string" || r.enrichment_at.trim() === "") return null;
  return hydrateStoredEnrichment(r);
}

/**
 * The name to show for a session, in precedence order.
 *
 * A human-authored title always wins — that is the point of `ccs session title`. Enrichment comes
 * next because it is the only title generated with knowledge of how the session actually turned
 * out; everything below it (Claude Code's early `ai-title`, the codex titler, the first-message
 * fallback) is a guess made from the opening turns. `indexTitle` carries that resolved fallback.
 */
export function displayTitle(row: CatalogueRow | null, indexTitle: string): string {
  const custom = row?.customTitle?.trim();
  if (custom) return custom;
  const enriched = row?.enrichment?.title?.trim();
  if (enriched) return enriched;
  return indexTitle;
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

/** Pure: lifecycle from a row. Saved hides resumable work; terminal legacy archive folds into Done. */
export function lifecycleOf(row: CatalogueRow | null): Lifecycle {
  if (!row) return "idle";
  if (row.saved) return "saved";
  if (row.completed || row.archived) return "completed";
  if (row.parkedTaskId) return "parked";
  return "idle";
}

/**
 * Pure: the canonical identity key for system-level grouping. ADR-D1 (2026-07-14): ccs is the
 * SINGLE SOURCE OF TRUTH — the `key` column is auto-derived on every mutation that touches an
 * identity-relevant field (see `deriveKey`), so `row.key` is authoritative and no consumer (TS
 * or Python engine) ever re-derives. Historical bug: three parallel implementations (lineage.ts,
 * db-queries.ts, compose_board.py) drifted; centralizing derivation kills the drift class at the root.
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
       WHERE p.gus_work = $g AND c.incognito IS NOT 1`,
    ).all({ $g: gusWork }) as { session_id: string }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: which sessions belong to this work-unit (ADR-0057).
 * ADR-0089 v33: work_unit_id was folded into identity_key, so this returns sessions whose
 * identity_key matches the passed value (callers should just pass identity_key directly). */
export function sessionsForWorkUnit(db: Database, workUnitId: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE identity_key = $k AND incognito IS NOT 1").all({ $k: workUnitId }) as {
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
       WHERE i.role = $r AND c.incognito IS NOT 1 ${MRU_ORDER.replace("updated_at", "c.updated_at").replace("session_id", "c.session_id")}`,
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
           WHERE p.pr_number = $n AND p.pr_repo = $repo AND c.incognito IS NOT 1 ${order}`,
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


/** Reverse lookup: sessions belonging to a grouping. Joins through identities post-ADR-0089. */
export function sessionsForEpic(db: Database, groupingId: string): string[] {
  return (
    db.query(
      `SELECT c.session_id FROM catalogue c
       JOIN identities i ON i.identity_key = c.identity_key
       WHERE i.grouping_id = $g AND c.incognito IS NOT 1`,
    ).all({ $g: groupingId }) as { session_id: string }[]
  ).map((r) => r.session_id);
}

/** Reverse lookup: which sessions are assigned to this identity_key. Post-ADR-0089 v33
 * the legacy `key` column is gone; this now queries the FK directly. */
export function sessionsForKey(db: Database, key: string): string[] {
  return (
    db.query("SELECT session_id FROM catalogue WHERE identity_key = $k AND incognito IS NOT 1").all({ $k: key }) as {
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
       WHERE i.cluster = $c AND c.incognito IS NOT 1 ${MRU_ORDER.replace("updated_at", "c.updated_at").replace("session_id", "c.session_id")}`,
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

export function getTags(db: Database, sessionId: string): string[] {
  return (
    db.query("SELECT entity FROM session_tags WHERE session_id = $id ORDER BY entity").all({
      $id: sessionId,
    }) as { entity: string }[]
  ).map((r) => r.entity);
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

/** Reverse lookup: which sessions are tagged with this entity. */
export function sessionsForEntity(db: Database, entity: string): string[] {
  return (
    db.query("SELECT session_id FROM session_tags WHERE entity = $e").all({ $e: entity }) as {
      session_id: string;
    }[]
  ).map((r) => r.session_id);
}
