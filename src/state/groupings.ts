import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readClusterDoc, writeClusterDoc } from "./cluster-state.ts";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";

/**
 * Grouping runtime state (ADR-0051): a "grouping" (a.k.a. epic) is a mid-level work grouping.
 * Its DISPLAY metadata — label, link, shortname — and its accumulating NOTES are RUNTIME state,
 * written by the cluster's own adapter (for pr-watch, the GUS sensor). The platform holds only a
 * generic slot; it does NOT know the link is a GUS url. This replaces the hardcoded `epics`
 * sqlite table that leaked a cluster concept into the platform schema.
 *
 * Stored per cluster at ~/.ccs/clusters/<cluster>/cluster/groupings.json (one doc, id-keyed),
 * via the same enveloped/atomic cluster-state store. The authored CONTEXT for a grouping is a
 * separate concern — it's the config-side `.ccs-hooks/claude-md.md` (a definition), not here.
 */

export interface Grouping {
  /** Human-facing label (full name or a short form). */
  label: string | null;
  /** A deep link to the grouping in its tracker (GUS/GitHub/…) — a cluster-adapter detail. */
  url: string | null;
  /** Column-friendly short label; ccs-derived from the name, hand-overridable. */
  shortName: string | null;
  /** Agent-accumulated project memory — learnings that affect the whole grouping (ADR-0051). */
  notes: string[];
  updatedAt: string | null;
}

/** The doc shape: groupingId -> Grouping. */
type GroupingsDoc = Record<string, Grouping>;

/** The display projection the cross-cluster ccs TUI consumes (name = the grouping's label). */
export interface EpicDisplay {
  name: string | null;
  shortName: string | null;
  url: string | null;
}

const DOC = "groupings";

/** Derive a short, column-friendly label from a full grouping name: drop a "[Team]" prefix +
 * "FY27" filler, cut at a natural boundary. A caller-supplied shortName always wins. A cluster
 * adapter uses this when it doesn't have its own short form. */
export function deriveShortName(name: string | null): string | null {
  if (!name) return null;
  let s = name.replace(/^\[[^\]]+\]\s*/, "").replace(/^FY\d{2}\s+/, "").trim();
  s = s.split(/\s*[&:—-]\s*/)[0]!.trim();
  const words = s.split(/\s+/);
  return (words.length > 4 ? words.slice(0, 4).join(" ") : s) || null;
}

function readAll(cluster: string): GroupingsDoc {
  const doc = readClusterDoc<GroupingsDoc>(ccsRuntimeRoot(), cluster, DOC);
  return doc?.data ?? {};
}

/** Read one grouping's runtime metadata, or null. */
export function getGrouping(cluster: string, groupingId: string): Grouping | null {
  return readAll(cluster)[groupingId] ?? null;
}

/** All groupings for a cluster (id -> Grouping). */
export function allGroupings(cluster: string): GroupingsDoc {
  return readAll(cluster);
}

/**
 * Every grouping across every cluster, id -> Grouping (for the cross-cluster ccs TUI, which
 * shows a session's grouping regardless of its cluster). Reads each cluster's groupings.json.
 * A grouping id collision across clusters is vanishingly unlikely (they're tracker ids), and
 * last-write-wins is fine for a display map. Best-effort: an unreadable cluster is skipped.
 */
export function allGroupingsAcrossClusters(): Map<string, Grouping> {
  const out = new Map<string, Grouping>();
  const clustersRoot = join(ccsRuntimeRoot(), "clusters");
  let clusters: string[] = [];
  try {
    clusters = readdirSync(clustersRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out; // no clusters dir yet
  }
  for (const cluster of clusters) {
    for (const [id, g] of Object.entries(readAll(cluster))) out.set(id, g);
  }
  return out;
}

/**
 * Upsert a grouping's SENSED metadata (label/url/shortName) — the cluster adapter's write path.
 * Preserves existing notes (they accumulate separately). `now` stamps the envelope + row.
 */
export function upsertGrouping(
  cluster: string,
  groupingId: string,
  fields: { label?: string | null; url?: string | null; shortName?: string | null },
  now: string,
  source = "cli",
): void {
  const all = readAll(cluster);
  const prev = all[groupingId];
  all[groupingId] = {
    label: fields.label ?? prev?.label ?? null,
    url: fields.url ?? prev?.url ?? null,
    shortName: fields.shortName ?? prev?.shortName ?? null,
    notes: prev?.notes ?? [],
    updatedAt: now,
  };
  writeClusterDoc(ccsRuntimeRoot(), cluster, DOC, all, { now, source });
}

/**
 * Append a note to a grouping (agent-accumulated project memory, ADR-0051). Creates the grouping
 * if absent (a note can arrive before the sensor fills the metadata). De-dupes exact repeats.
 */
export function appendGroupingNote(
  cluster: string,
  groupingId: string,
  note: string,
  now: string,
  source = "cli",
): void {
  const trimmed = note.trim();
  if (!trimmed) return;
  const all = readAll(cluster);
  const prev = all[groupingId] ?? { label: null, url: null, shortName: null, notes: [], updatedAt: null };
  if (!prev.notes.includes(trimmed)) prev.notes = [...prev.notes, trimmed];
  prev.updatedAt = now;
  all[groupingId] = prev;
  writeClusterDoc(ccsRuntimeRoot(), cluster, DOC, all, { now, source });
}
