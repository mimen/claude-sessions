import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow, EpicRow } from "../catalogue/db.ts";
import { sortRows, type DisplayItem, type SectionMeta, type SortMode } from "./groupByProject.ts";

/**
 * Cluster view: group sessions by `system` (an operation like pr-watch), and within a
 * system split CORE (the star/support roles: control/concierge/eval/designer) from
 * FLEET (the per-PR workers), each fleet role its own sub-section. Sessions with no
 * system fall into a trailing "(no system)" bucket so nothing is hidden.
 *
 * This is the interactive twin of `ccs cluster` — same core/fleet split, but navigable
 * with the list's collapse/expand + selection. Membership is by `system` (not the
 * parent graph), because core sessions are deliberately parent-less peers.
 */

/** Roles that are CORE (the star/support that runs a cluster). Others are fleet. */
const CORE_ROLES = new Set(["pr-watch-control", "pr-watch-2", "pr-watch-eval", "loop-designer"]);
const CORE_ORDER = ["pr-watch-control", "pr-watch-2", "pr-watch-eval", "loop-designer"];

export interface ClusterViewCtx {
  catMap: ReadonlyMap<string, CatalogueRow>;
  epicMap: ReadonlyMap<string, EpicRow>;
  openSet: ReadonlySet<string>;
  collapsedSections: ReadonlySet<string>;
  expandedSessions?: ReadonlySet<string>;
  childCounts?: ReadonlyMap<string, number>;
  childrenByParent?: ReadonlyMap<string, SessionRow[]>;
  sort?: SortMode;
  costOf?: (row: SessionRow) => number;
}

/**
 * Cluster view structure (Milad's ask): for each system, TWO tiers —
 *   CORE   : the star/support sessions, one section per core role (★)
 *   WORKERS: the fleet, grouped BY EPIC (using each epic's short name)
 * Sessions with no system fall into a trailing "(no system)" tier.
 */
export function buildClusterView(rows: readonly SessionRow[], ctx: ClusterViewCtx): DisplayItem[] {
  const expandedSessions = ctx.expandedSessions ?? new Set<string>();
  const childCounts = ctx.childCounts ?? new Map<string, number>();
  const childrenByParent = ctx.childrenByParent ?? new Map<string, SessionRow[]>();
  const sort = ctx.sort ?? "recent";
  const costOf = ctx.costOf ?? (() => 0);

  // system -> { core: role->rows, workers: epicKey->rows }
  interface SysBuckets { core: Map<string, SessionRow[]>; workers: Map<string, SessionRow[]> }
  const bySystem = new Map<string, SysBuckets>();
  for (const row of rows) {
    const cat = ctx.catMap.get(row.sessionId) ?? null;
    const system = cat?.system ?? "";
    const role = cat?.skill ?? "(unroled)";
    const b = bySystem.get(system) ?? bySystem.set(system, { core: new Map(), workers: new Map() }).get(system)!;
    if (CORE_ROLES.has(role)) {
      (b.core.get(role) ?? b.core.set(role, []).get(role)!).push(row);
    } else {
      const epicKey = cat?.epicId ?? ""; // "" = no epic
      (b.workers.get(epicKey) ?? b.workers.set(epicKey, []).get(epicKey)!).push(row);
    }
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

  const emit = (key: string, name: string, glyph: string, rowsIn: SessionRow[]): void => {
    if (rowsIn.length === 0) return;
    const collapsed = ctx.collapsedSections.has(key);
    const cost = rowsIn.reduce((sum, r) => sum + costOf(r), 0);
    items.push({ kind: "section", section: { key, name, glyph }, count: rowsIn.length, collapsed, cost });
    if (!collapsed) for (const r of sortRows(rowsIn, sort, costOf)) pushSession(r, 0);
  };

  const epicLabel = (epicKey: string): string => {
    if (!epicKey) return "(no epic)";
    const e = ctx.epicMap.get(epicKey);
    return e?.shortName || e?.name?.replace(/^\[[^\]]+\]\s*/, "") || epicKey;
  };

  const systems = [...bySystem.keys()].filter((s) => s !== "").sort();
  for (const system of systems) {
    const b = bySystem.get(system)!;
    // CORE tier — one section per core role, fixed order, ★.
    for (const role of CORE_ORDER) {
      if (b.core.has(role)) emit(`cluster:${system}:core:${role}`, `${system} ▸ core ▸ ${role}  ★`, "★", b.core.get(role)!);
    }
    for (const role of [...b.core.keys()].filter((r) => !CORE_ORDER.includes(r)).sort()) {
      emit(`cluster:${system}:core:${role}`, `${system} ▸ core ▸ ${role}  ★`, "★", b.core.get(role)!);
    }
    // WORKERS tier — grouped by epic (short name), biggest epic first, "(no epic)" last.
    const epicKeys = [...b.workers.keys()].sort((a, z) => {
      if ((a === "") !== (z === "")) return a === "" ? 1 : -1;
      const d = b.workers.get(z)!.length - b.workers.get(a)!.length;
      return d !== 0 ? d : epicLabel(a).localeCompare(epicLabel(z));
    });
    for (const ek of epicKeys) {
      emit(`cluster:${system}:workers:${ek || "(none)"}`, `${system} ▸ workers ▸ ${epicLabel(ek)}`, "◈", b.workers.get(ek)!);
    }
  }
  // No-system sessions — trailing.
  const none = bySystem.get("");
  if (none) {
    for (const [ek, rowsIn] of none.workers) emit(`cluster::none:${ek || "(none)"}`, `(no system)`, "·", rowsIn);
    for (const [role, rowsIn] of none.core) emit(`cluster::none:${role}`, `(no system) ▸ ${role}`, "·", rowsIn);
  }
  return items;
}
