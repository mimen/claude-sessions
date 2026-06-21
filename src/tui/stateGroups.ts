import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import { lifecycleOf } from "../catalogue/db.ts";
import type { DisplayItem, SectionMeta } from "./groupByProject.ts";

/**
 * Group sessions by lifecycle state for triage (the default view). Sections in a fixed
 * priority order; STALE/DONE/ARCHIVED collapse by default so the live working set leads.
 */

export type SectionKey = "active" | "loops" | "parked" | "recent" | "stale" | "done" | "archived";

export const SECTIONS: { key: SectionKey; name: string; glyph: string }[] = [
  { key: "active", name: "ACTIVE", glyph: "●" },
  { key: "loops", name: "LOOPS", glyph: "◆" },
  { key: "parked", name: "PARKED", glyph: "⏸" },
  { key: "recent", name: "RECENTLY IDLE", glyph: " " },
  { key: "stale", name: "STALE", glyph: " " },
  { key: "done", name: "DONE", glyph: "✓" },
  { key: "archived", name: "ARCHIVED", glyph: "·" },
];

/** Sections collapsed by default — the long tail. */
export const DEFAULT_COLLAPSED: ReadonlySet<string> = new Set(["stale", "done", "archived"]);

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

export function classify(
  row: SessionRow,
  cat: CatalogueRow | null,
  open: boolean,
  nowMs: number,
): SectionKey {
  if (cat?.kind === "loop") return "loops";
  const lc = lifecycleOf(cat);
  if (lc === "archived") return "archived";
  if (lc === "completed") return "done";
  if (lc === "parked") return "parked";
  if (open) return "active";
  const ts = row.lastTs ? Date.parse(row.lastTs) : NaN;
  if (Number.isNaN(ts) || nowMs - ts > STALE_MS) return "stale";
  return "recent";
}

export interface StateGroupCtx {
  catMap: ReadonlyMap<string, CatalogueRow>;
  openSet: ReadonlySet<string>;
  nowMs: number;
  collapsedSections: ReadonlySet<string>;
  expandedSessions?: ReadonlySet<string>;
  childCounts?: ReadonlyMap<string, number>;
  childrenByParent?: ReadonlyMap<string, SessionRow[]>;
}

/** Flatten rows into section headers + sessions, honoring collapse + subagent expansion. */
export function buildStateItems(rows: readonly SessionRow[], ctx: StateGroupCtx): DisplayItem[] {
  const expandedSessions = ctx.expandedSessions ?? new Set<string>();
  const childCounts = ctx.childCounts ?? new Map<string, number>();
  const childrenByParent = ctx.childrenByParent ?? new Map<string, SessionRow[]>();

  const buckets = new Map<SectionKey, SessionRow[]>();
  for (const row of rows) {
    const key = classify(row, ctx.catMap.get(row.sessionId) ?? null, ctx.openSet.has(row.sessionId), ctx.nowMs);
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(row);
  }

  const items: DisplayItem[] = [];
  const pushSession = (row: SessionRow, depth: number): void => {
    const expanded = expandedSessions.has(row.sessionId);
    items.push({ kind: "session", row, depth, childCount: childCounts.get(row.sessionId) ?? 0, expanded });
    if (expanded) {
      for (const child of childrenByParent.get(row.sessionId) ?? []) {
        items.push({ kind: "session", row: child, depth: depth + 1, childCount: 0, expanded: false });
      }
    }
  };

  for (const meta of SECTIONS) {
    const rowsIn = buckets.get(meta.key as SectionKey);
    if (!rowsIn || rowsIn.length === 0) continue;
    const collapsed = ctx.collapsedSections.has(meta.key);
    const section: SectionMeta = { key: meta.key, name: meta.name, glyph: meta.glyph };
    items.push({ kind: "section", section, count: rowsIn.length, collapsed });
    if (!collapsed) for (const row of rowsIn) pushSession(row, 0);
  }
  return items;
}
