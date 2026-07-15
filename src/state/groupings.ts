import { openCatalogue } from "../catalogue/db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import {
  appendNote,
  getGrouping as dbGetGrouping,
  listGroupings as dbListGroupings,
  upsertGrouping as dbUpsertGrouping,
} from "./groupings-db.ts";

/**
 * ADR-0089 step 4: this module is now a THIN COMPATIBILITY SHIM over the DB-backed
 * groupings-db.ts. Callers keep the pre-refactor API; storage lives in the `groupings` table.
 *
 * The Grouping shape and derive/read/write functions are preserved so TUI + hooks + sync-tabs
 * don't churn now; those callers get migrated to groupings-db.ts directly in step 11 (TUI
 * update). Once every consumer routes through the new module, this shim can go away.
 */

export interface Grouping {
  label: string | null;
  url: string | null;
  shortName: string | null;
  notes: string[];
  updatedAt: string | null;
}

export interface EpicDisplay {
  name: string | null;
  shortName: string | null;
  url: string | null;
}

type GroupingsDoc = Record<string, Grouping>;

function stripToLegacy(g: {
  label: string | null;
  url: string | null;
  shortName: string | null;
  notes: string[];
  updatedAt: string | null;
}): Grouping {
  return {
    label: g.label,
    url: g.url,
    shortName: g.shortName,
    notes: g.notes,
    updatedAt: g.updatedAt,
  };
}

/** Derive a short, column-friendly label from a full grouping name. Unchanged from ADR-0051. */
export function deriveShortName(name: string | null): string | null {
  if (!name) return null;
  let s = name.replace(/^\[[^\]]+\]\s*/, "").replace(/^FY\d{2}\s+/, "").trim();
  s = s.split(/\s*[&:—-]\s*/)[0]!.trim();
  const words = s.split(/\s+/);
  return (words.length > 4 ? words.slice(0, 4).join(" ") : s) || null;
}

/** Read one grouping (any cluster) — the shim ignores the passed cluster arg since grouping_id
 * is globally unique across clusters (tracker ids don't collide). Preserved for API stability. */
export function getGrouping(_cluster: string, groupingId: string): Grouping | null {
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const g = dbGetGrouping(db, groupingId);
    return g ? stripToLegacy(g) : null;
  } finally {
    db.close();
  }
}

/** All groupings for a cluster (id -> Grouping). */
export function allGroupings(cluster: string): GroupingsDoc {
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const rows = dbListGroupings(db, { cluster });
    const out: GroupingsDoc = {};
    for (const g of rows) out[g.groupingId] = stripToLegacy(g);
    return out;
  } finally {
    db.close();
  }
}

/** Every grouping across every cluster (id -> Grouping). Fail-open — if the DB can't be
 * opened (fresh test env, permission issues), return an empty map. The TUI is a read-side
 * consumer here; a missing groupings list is a display gap, not a fatal error. */
export function allGroupingsAcrossClusters(): Map<string, Grouping> {
  try {
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    try {
      const rows = dbListGroupings(db);
      const m = new Map<string, Grouping>();
      for (const g of rows) m.set(g.groupingId, stripToLegacy(g));
      return m;
    } finally {
      db.close();
    }
  } catch {
    return new Map();
  }
}

/** Upsert display metadata (sensor write path). role defaults to pr-agent when not passed —
 * legacy callers didn't specify role; DB requires it. This is safe because only pr-watch's
 * pr-agent uses groupings today. */
export function upsertGrouping(
  cluster: string,
  groupingId: string,
  fields: { label?: string | null; url?: string | null; shortName?: string | null },
  now: string,
  _source = "cli",
): void {
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const existing = dbGetGrouping(db, groupingId);
    const role = existing?.role ?? "pr-agent";
    dbUpsertGrouping(
      db,
      groupingId,
      {
        cluster,
        role,
        label: fields.label,
        url: fields.url,
        shortName: fields.shortName,
      },
      now,
    );
  } finally {
    db.close();
  }
}

/** Append a note (deduped). */
export function appendGroupingNote(
  cluster: string,
  groupingId: string,
  note: string,
  now: string,
  _source = "cli",
): void {
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const existing = dbGetGrouping(db, groupingId);
    const role = existing?.role ?? "pr-agent";
    appendNote(db, groupingId, cluster, role, note, now);
  } finally {
    db.close();
  }
}
