import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { EpicDisplay } from "../state/groupings.ts";
import { sortRows, type DisplayItem, type SectionMeta, type SortMode } from "./groupByProject.ts";

/**
 * Epic view: group a system's workers by the EPIC their work item belongs to. A
 * session's epic is resolved from its epic_id -> the epics entity (name). Sessions
 * with no epic fall into "(no epic)"; sessions with no system are excluded (this view
 * is about organizing the fleet's work by initiative).
 *
 * The complement to the cluster view: cluster = by role (who runs it / who works it),
 * epic = by initiative (what larger goal the work rolls up to).
 */

export interface EpicViewCtx {
  catMap: ReadonlyMap<string, CatalogueRow>;
  epicMap: ReadonlyMap<string, EpicDisplay>;
  collapsedSections: ReadonlySet<string>;
  expandedSessions?: ReadonlySet<string>;
  childCounts?: ReadonlyMap<string, number>;
  childrenByParent?: ReadonlyMap<string, SessionRow[]>;
  sort?: SortMode;
  costOf?: (row: SessionRow) => number;
  /** Only include sessions in this system (default: any session that has a system). */
  system?: string;
}

/** Trim the "[Front End] " team prefix + "FY27 " filler for a compact section label. */
function epicLabel(name: string): string {
  return name.replace(/^\[[^\]]+\]\s*/, "").replace(/^FY\d{2}\s+/, "").trim();
}

export function buildEpicView(rows: readonly SessionRow[], ctx: EpicViewCtx): DisplayItem[] {
  const expandedSessions = ctx.expandedSessions ?? new Set<string>();
  const childCounts = ctx.childCounts ?? new Map<string, number>();
  const childrenByParent = ctx.childrenByParent ?? new Map<string, SessionRow[]>();
  const sort = ctx.sort ?? "recent";
  const costOf = ctx.costOf ?? (() => 0);

  // Bucket by epic_id (or "" for no-epic). Only sessions that belong to a system.
  const byEpic = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const cat = ctx.catMap.get(row.sessionId) ?? null;
    if (!cat?.cluster) continue; // epic view is for cluster members
    if (ctx.system && cat.cluster !== ctx.system) continue;
    const epicId = cat.epicId ?? "";
    (byEpic.get(epicId) ?? byEpic.set(epicId, []).get(epicId)!).push(row);
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

  // Named epics first (by session count desc, then name), "(no epic)" last.
  const entries = [...byEpic.entries()];
  entries.sort((a, b) => {
    if ((a[0] === "") !== (b[0] === "")) return a[0] === "" ? 1 : -1; // no-epic last
    if (b[1].length !== a[1].length) return b[1].length - a[1].length; // bigger epics first
    return a[0].localeCompare(b[0]);
  });

  for (const [epicId, rowsIn] of entries) {
    if (rowsIn.length === 0) continue;
    const key = `epic:${epicId || "(none)"}`;
    const collapsed = ctx.collapsedSections.has(key);
    const name = epicId ? (ctx.epicMap.get(epicId)?.name ?? epicId) : "(no epic)";
    const section: SectionMeta = { key, name: epicId ? epicLabel(name) : "(no epic)", glyph: "◈" };
    const cost = rowsIn.reduce((sum, r) => sum + costOf(r), 0);
    items.push({ kind: "section", section, count: rowsIn.length, collapsed, cost });
    if (!collapsed) for (const r of sortRows(rowsIn, sort, costOf)) pushSession(r, 0);
  }
  return items;
}
