import type { Database } from "bun:sqlite";

/**
 * ADR-0089 step 4: groupings live in the `groupings` table (created by v32 migration).
 * Replaces the per-cluster `groupings.json` file store from src/state/groupings.ts.
 *
 * Columns (see catalogue/db.ts v32 block for CREATE):
 *   grouping_id  PK   opaque id from tracker (GUS ADM_Work__c, Linear project id, …)
 *   cluster           which cluster this grouping belongs to
 *   role              which fleet role uses this grouping (identifies the type via role.toml)
 *   label             human-facing name
 *   url               deep link to the tracker
 *   short_name        column-friendly form
 *   notes             JSON array — accumulating project memory
 *   context           long-form authored context (optional)
 *   closed            0/1 — retired vs active
 *   meta              JSON escape hatch
 *   updated_at        ISO timestamp
 *
 * The groupings.json → groupings table one-time migration runs on ccs boot via
 * migrateGroupingsJsonToDb() below; it walks every ~/.ccs/clusters/<c>/cluster/groupings.json
 * and upserts rows. Idempotent (INSERT OR IGNORE on new; skip on existing).
 */

export interface GroupingRow {
  groupingId: string;
  cluster: string;
  role: string;
  label: string | null;
  url: string | null;
  shortName: string | null;
  notes: string[];
  context: string | null;
  closed: boolean;
  meta: Record<string, unknown>;
  updatedAt: string | null;
}

function fromRow(r: Record<string, unknown>): GroupingRow {
  return {
    groupingId: r.grouping_id as string,
    cluster: r.cluster as string,
    role: r.role as string,
    label: (r.label as string) ?? null,
    url: (r.url as string) ?? null,
    shortName: (r.short_name as string) ?? null,
    notes: parseJsonArray(r.notes as string | null),
    context: (r.context as string) ?? null,
    closed: !!(r.closed as number),
    meta: parseJsonObject(r.meta as string | null),
    updatedAt: (r.updated_at as string) ?? null,
  };
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Read one grouping by id, or null. */
export function getGrouping(db: Database, groupingId: string): GroupingRow | null {
  const r = db.query("SELECT * FROM groupings WHERE grouping_id = $id").get({ $id: groupingId }) as
    | Record<string, unknown>
    | null;
  return r ? fromRow(r) : null;
}

export interface ListFilters {
  cluster?: string;
  role?: string;
  closed?: boolean;
}

/** List groupings, optionally filtered by cluster / role / closed. */
export function listGroupings(db: Database, filters: ListFilters = {}): GroupingRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.cluster) {
    clauses.push("cluster = $cluster");
    params.$cluster = filters.cluster;
  }
  if (filters.role) {
    clauses.push("role = $role");
    params.$role = filters.role;
  }
  if (filters.closed !== undefined) {
    clauses.push("closed = $closed");
    params.$closed = filters.closed ? 1 : 0;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT * FROM groupings ${where} ORDER BY grouping_id`).all(params) as Record<
    string,
    unknown
  >[];
  return rows.map(fromRow);
}

/**
 * Upsert a grouping. Missing fields on an INSERT default to null; missing fields on an UPDATE
 * preserve existing values (partial update). Notes + context + closed + meta are updated only
 * when explicitly provided; use setNotes/setContext/setClosed for those to avoid ambiguity.
 */
export interface UpsertFields {
  cluster: string;
  role: string;
  label?: string | null;
  url?: string | null;
  shortName?: string | null;
  context?: string | null;
  closed?: boolean;
  meta?: Record<string, unknown>;
}

export function upsertGrouping(db: Database, groupingId: string, fields: UpsertFields, now: string): void {
  const existing = getGrouping(db, groupingId);
  if (!existing) {
    db.query(
      `INSERT INTO groupings
         (grouping_id, cluster, role, label, url, short_name, notes, context, closed, meta, updated_at)
       VALUES ($id, $cluster, $role, $label, $url, $short, $notes, $context, $closed, $meta, $now)`,
    ).run({
      $id: groupingId,
      $cluster: fields.cluster,
      $role: fields.role,
      $label: fields.label ?? null,
      $url: fields.url ?? null,
      $short: fields.shortName ?? null,
      $notes: JSON.stringify([]),
      $context: fields.context ?? null,
      $closed: fields.closed ? 1 : 0,
      $meta: JSON.stringify(fields.meta ?? {}),
      $now: now,
    });
    return;
  }
  // Partial update: only overwrite provided fields.
  const merged = {
    cluster: fields.cluster ?? existing.cluster,
    role: fields.role ?? existing.role,
    label: fields.label !== undefined ? fields.label : existing.label,
    url: fields.url !== undefined ? fields.url : existing.url,
    shortName: fields.shortName !== undefined ? fields.shortName : existing.shortName,
    context: fields.context !== undefined ? fields.context : existing.context,
    closed: fields.closed !== undefined ? fields.closed : existing.closed,
    meta: fields.meta !== undefined ? fields.meta : existing.meta,
  };
  db.query(
    `UPDATE groupings
       SET cluster = $cluster, role = $role, label = $label, url = $url, short_name = $short,
           context = $context, closed = $closed, meta = $meta, updated_at = $now
     WHERE grouping_id = $id`,
  ).run({
    $id: groupingId,
    $cluster: merged.cluster,
    $role: merged.role,
    $label: merged.label,
    $url: merged.url,
    $short: merged.shortName,
    $context: merged.context,
    $closed: merged.closed ? 1 : 0,
    $meta: JSON.stringify(merged.meta),
    $now: now,
  });
}

/** Append a note (deduped) to a grouping. Creates the grouping (with null attrs) if absent. */
export function appendNote(
  db: Database,
  groupingId: string,
  cluster: string,
  role: string,
  note: string,
  now: string,
): void {
  const trimmed = note.trim();
  if (!trimmed) return;
  const existing = getGrouping(db, groupingId);
  if (!existing) {
    upsertGrouping(db, groupingId, { cluster, role }, now);
  }
  const cur = getGrouping(db, groupingId)!;
  if (cur.notes.includes(trimmed)) return;
  const next = [...cur.notes, trimmed];
  db.query("UPDATE groupings SET notes = $n, updated_at = $now WHERE grouping_id = $id").run({
    $n: JSON.stringify(next),
    $now: now,
    $id: groupingId,
  });
}

/** Mark a grouping closed (retired). Identities can still reference it; queries filter it out. */
export function setClosed(db: Database, groupingId: string, closed: boolean, now: string): void {
  db.query("UPDATE groupings SET closed = $c, updated_at = $now WHERE grouping_id = $id").run({
    $c: closed ? 1 : 0,
    $now: now,
    $id: groupingId,
  });
}

/** Delete a grouping — rare; use closed=true for retirement. */
export function deleteGrouping(db: Database, groupingId: string): void {
  db.query("DELETE FROM groupings WHERE grouping_id = $id").run({ $id: groupingId });
}
