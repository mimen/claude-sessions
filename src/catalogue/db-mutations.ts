import type { Database } from "bun:sqlite";
import type { Enrichment } from "./enrichment-schema.ts";
import { hasColumn } from "./db-schema.ts";
import type {
  CreatorKind,
  HistoricalDetachedChildBackfillAudit,
  LaunchChannel,
  PrFacts,
  SessionClass,
} from "./db-schema.ts";
import { deriveKey, getRow } from "./db-queries.ts";

/** Ensure a row exists for sessionId (no-op if present), so updates can UPDATE in place. */
export function ensureRow(db: Database, sessionId: string, now: string): void {
  db.query(
    "INSERT INTO catalogue (session_id, updated_at) VALUES ($id, $now) ON CONFLICT(session_id) DO NOTHING",
  ).run({ $id: sessionId, $now: now });
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
export function setSaved(db: Database, sessionId: string, saved: boolean, now: string): void {
  set(db, sessionId, "saved", saved ? 1 : 0, now);
}
export function setParked(db: Database, sessionId: string, taskId: string | null, now: string): void {
  set(db, sessionId, "parked_task_id", taskId, now);
}
export function setIncognito(db: Database, sessionId: string, incognito: boolean, now: string): void {
  set(db, sessionId, "incognito", incognito ? 1 : 0, now);
}

/**
 * Record positive T3 provenance and the index alias atomically. The flag is monotonic: no automatic
 * path clears it, and a conflicting existing alias is rejected instead of weakening identity.
 */
export function markT3Associated(
  db: Database,
  sessionId: string,
  resumeId: string,
  now: string,
): "changed" | "unchanged" | "conflict" | "not-found" | "ambiguous" {
  type Candidate = { session_id: string; resume_id: string | null; t3_associated: number };
  const aliasCandidates = db.query(
    "SELECT session_id, resume_id, t3_associated FROM catalogue WHERE resume_id = $resume",
  ).all({ $resume: resumeId }) as Candidate[];
  if (aliasCandidates.length > 1) return "ambiguous";
  const current = aliasCandidates[0] ?? db.query(
    "SELECT session_id, resume_id, t3_associated FROM catalogue WHERE session_id = $id",
  ).get({ $id: sessionId }) as Candidate | null;
  if (!current) return "not-found";
  if (current.resume_id && current.resume_id !== resumeId) return "conflict";
  if (current.t3_associated === 1 && current.resume_id === resumeId) return "unchanged";
  db.query(
    `UPDATE catalogue
       SET resume_id = COALESCE(resume_id, $resume), t3_associated = 1, updated_at = $now
     WHERE session_id = $id`,
  ).run({ $id: current.session_id, $resume: resumeId, $now: now });
  return "changed";
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
 * Write a complete enrichment in ONE statement (v38).
 *
 * Deliberately not eleven `set()` calls: enrichment is a single observation, and a half-written
 * one is worse than none — `enrichment_at` is the presence key `enrichmentFrom` reads, so a crash
 * between column writes could otherwise leave a row claiming to be enriched with an empty summary.
 * A successful write also zeroes the attempt counter, so a session that recovers after transient
 * failures gets its full retry budget back.
 */
export function setEnrichment(
  db: Database,
  sessionId: string,
  enrichment: Enrichment,
  now: string,
): void {
  ensureRow(db, sessionId, now);
  db.query(
    `UPDATE catalogue SET
       enrichment_title = $title,
       enrichment_state = $state,
       enrichment_history = $history,
       enrichment_next = $next,
       enrichment_remaining = $remaining,
       -- Transitional dual-write, removed by v41 along with the columns themselves.
       -- Readers that predate v40 select these columns directly out of SQL (the ccs-go dossier
       -- does), so writing only the new ones would blank their panels for every session the
       -- cutover sweep touches — a migration that breaks the surface it exists to improve.
       enrichment_summary = $state,
       enrichment_outstanding = $next,
       enrichment_recommendation = $recommendation,
       enrichment_reason = $reason,
       enrichment_junk = $junk,
       enrichment_cwd_correct = $cwdCorrect,
       enrichment_suggested_location = $suggestedLocation,
       enrichment_suggested_cwd = $suggestedCwd,
       enrichment_at_messages = $atMessages,
       enrichment_at = $at,
       enrichment_attempts = 0,
       updated_at = $now
     WHERE session_id = $id`,
  ).run({
    $title: enrichment.title,
    $state: enrichment.state,
    $history: enrichment.history,
    $next: enrichment.next,
    $remaining: enrichment.remaining,
    $recommendation: enrichment.recommendation,
    $reason: enrichment.reason,
    $junk: enrichment.junk ? 1 : 0,
    // undefined means the cwd question was never asked; NULL preserves that as distinct from a
    // judgement of "wrong directory".
    $cwdCorrect: enrichment.cwdCorrect === undefined ? null : enrichment.cwdCorrect ? 1 : 0,
    $suggestedLocation: enrichment.suggestedLocation || null,
    $suggestedCwd: enrichment.suggestedCwd || null,
    $atMessages: enrichment.atMessages,
    $at: enrichment.at,
    $now: now,
    $id: sessionId,
  });
}

/**
 * Count one failed enrichment attempt. Mirrors `recordTitleFailure` in the index: a session the
 * model can't parse (or that keeps timing out) burns its budget and is then skipped forever,
 * rather than consuming a slot in every sweep for the rest of time.
 */
export function recordEnrichmentFailure(db: Database, sessionId: string, now: string): void {
  ensureRow(db, sessionId, now);
  db.query(
    `UPDATE catalogue
       SET enrichment_attempts = COALESCE(enrichment_attempts, 0) + 1, updated_at = $now
     WHERE session_id = $id`,
  ).run({ $now: now, $id: sessionId });
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

// ---- tags ----

export function addTag(db: Database, sessionId: string, entity: string): void {
  if (entity.startsWith("domain:")) {
    throw new Error("domain tags must be written through setCategory");
  }
  db.query(
    "INSERT INTO session_tags (session_id, entity) VALUES ($id, $e) ON CONFLICT DO NOTHING",
  ).run({ $id: sessionId, $e: entity });
}
export function removeTag(db: Database, sessionId: string, entity: string): void {
  if (entity.startsWith("domain:")) {
    throw new Error("domain tags must be removed through setCategory");
  }
  db.query("DELETE FROM session_tags WHERE session_id = $id AND entity = $e").run({
    $id: sessionId,
    $e: entity,
  });
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
 * Drop every stored enrichment field for a session, so nothing a model wrote about it survives.
 *
 * Columns are discovered rather than listed: `enrichment_summary` and `enrichment_outstanding` are
 * scheduled for removal in the catalogue's reserved v41, and a hardcoded list would either break
 * on that migration or quietly stop clearing a column added after this was written. Whatever the
 * schema currently holds under the `enrichment_` prefix is what gets cleared.
 *
 * `enrichment_attempts` is a retry counter rather than an observation, so it resets to 0 instead of
 * going NULL — the column is NOT NULL and a null there would break the budget arithmetic.
 */
/**
 * What survives a clear.
 *
 * `enrichment_title` is the session's display name everywhere it is listed, and a marked session
 * still has to be identifiable while it is open -- an incognito section of bare session ids tells
 * you nothing. A one-line title is also the same class of thing as the cmux tab title, which is on
 * screen regardless and which incognito does not touch. The substantive model-written content is
 * the prose below it, and that is what this removes.
 *
 * `enrichment_at` still goes, so the row honestly reads as un-enriched. That does mean the hydrated
 * `row.enrichment` is null and `displayTitle` falls back to the index title -- which costs nothing,
 * because the surfaces `displayTitle` feeds (`ccs ls`, the TUI) exclude marked sessions outright.
 * The sidebar, the one surface that shows them, reads the column directly.
 */
const ENRICHMENT_COLUMNS_KEPT: ReadonlySet<string> = new Set(["enrichment_title"]);

export function clearEnrichment(db: Database, sessionId: string, now: string): void {
  const columns = (db.query("PRAGMA table_info(catalogue)").all() as Array<{ name: string }>)
    .map((column) => column.name)
    .filter((name) => name.startsWith("enrichment_") && !ENRICHMENT_COLUMNS_KEPT.has(name));
  if (columns.length === 0) return;
  const assignments = columns.map((name) =>
    name === "enrichment_attempts" ? `${name} = 0` : `${name} = NULL`,
  );
  db.query(
    `UPDATE catalogue SET ${assignments.join(", ")}, updated_at = $now WHERE session_id = $id`,
  ).run({ $now: now, $id: sessionId });
}

/**
 * Every catalogue table keyed by session id, ordered so a row never outlives what points at it.
 *
 * `catalogue` is last on purpose. The category tables carry no foreign key (this database declares
 * none at all), so nothing enforces the order for us; deleting the parent row first would leave
 * orphans behind if a later statement threw, and callers run this inside one transaction precisely
 * so that cannot happen.
 */
const SESSION_SCOPED_TABLES = [
  "session_tags",
  "session_category_assignments",
  "session_category_attempts",
  "catalogue",
] as const;

/**
 * Delete one session's rows from every catalogue table. Unguarded and unconditional: unlike
 * {@link deleteHistoricalDetachedChildBackfillPlaceholder} below, this is the destroy path, where
 * authored metadata is exactly what the caller means to remove.
 *
 * Presence-guarded per table because the category tables are created on a migration line
 * independent of the main version ladder, so a catalogue opened by an older binary can legitimately
 * lack them. Returns the per-table row counts for the destroy report.
 */
export function deleteSessionRows(db: Database, sessionId: string): Record<string, number> {
  const present = new Set(
    (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  const deleted: Record<string, number> = {};
  for (const table of SESSION_SCOPED_TABLES) {
    if (!present.has(table)) continue;
    const result = db.query(`DELETE FROM ${table} WHERE session_id = $id`).run({ $id: sessionId });
    if (result.changes > 0) deleted[table] = result.changes;
  }
  return deleted;
}

/**
 * Detach any surviving session that named the destroyed one as its causal parent.
 *
 * Only reachable when a caller destroys a partial subtree; a full recursive destroy removes these
 * rows outright. Without it the survivor keeps a `parent_session_id` pointing at nothing, which
 * reads as a corrupt constellation rather than an intentional top-level session.
 */
export function detachChildrenOf(db: Database, parentSessionId: string, now: string): number {
  return db.query(
    "UPDATE catalogue SET parent_session_id = NULL, updated_at = $now WHERE parent_session_id = $id",
  ).run({ $now: now, $id: parentSessionId }).changes;
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
        AND saved = 0
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
