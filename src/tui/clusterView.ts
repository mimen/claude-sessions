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
    items.push({
      kind: "session", row, depth, childCount: childCounts.get(row.sessionId) ?? 0, expanded,
      // Carry the live open-state so the list shows the active/idle dot (as groups mode does).
      openState: ctx.openSet.has(row.sessionId) ? "open" : "idle",
    });
    if (expanded) {
      for (const child of childrenByParent.get(row.sessionId) ?? []) {
        items.push({ kind: "session", row: child, depth: depth + 1, childCount: 0, expanded: false });
      }
    }
  };

  /** Emit a nested header at `level` (0 cluster, 1 core/workers tier, 2 epic/role). */
  const header = (key: string, name: string, glyph: string, level: number, count: number): void => {
    const collapsed = ctx.collapsedSections.has(key);
    items.push({ kind: "section", section: { key, name, glyph, level }, count, collapsed, cost: 0 });
  };

  /** A leaf group (epic or role) at `level`: its sub-header + the sessions under it. */
  const group = (key: string, name: string, glyph: string, level: number, rowsIn: SessionRow[]): void => {
    if (rowsIn.length === 0) return;
    header(key, name, glyph, level, rowsIn.length);
    if (!ctx.collapsedSections.has(key)) for (const r of sortRows(rowsIn, sort, costOf)) pushSession(r, level);
  };

  const epicLabel = (epicKey: string): string => {
    if (!epicKey) return "(no epic)";
    const e = ctx.epicMap.get(epicKey);
    return e?.shortName || e?.name?.replace(/^\[[^\]]+\]\s*/, "") || epicKey;
  };

  const systems = [...bySystem.keys()].filter((s) => s !== "").sort();
  for (const system of systems) {
    const b = bySystem.get(system)!;
    const total = [...b.core.values(), ...b.workers.values()].reduce((n, a) => n + a.length, 0);
    // LEVEL 0 — one cluster header for the whole system.
    header(`cluster:${system}`, system, "◇", 0, total);
    if (ctx.collapsedSections.has(`cluster:${system}`)) continue;

    // LEVEL 1 — CORE tier: a FLAT list under one header (role shown in the role column,
    // not as subgroups). Ordered by the fixed core-role order, then any extras.
    const coreRoles = [...CORE_ORDER.filter((r) => b.core.has(r)),
      ...[...b.core.keys()].filter((r) => !CORE_ORDER.includes(r)).sort()];
    const coreRows = coreRoles.flatMap((r) => b.core.get(r)!);
    if (coreRows.length > 0) group(`cluster:${system}:core`, "core ★", "★", 1, coreRows);

    // LEVEL 1 — WORKERS tier header, then one LEVEL-2 group per epic (short name).
    const epicKeys = [...b.workers.keys()].sort((a, z) => {
      if ((a === "") !== (z === "")) return a === "" ? 1 : -1;
      const d = b.workers.get(z)!.length - b.workers.get(a)!.length;
      return d !== 0 ? d : epicLabel(a).localeCompare(epicLabel(z));
    });
    const workerCount = epicKeys.reduce((n, k) => n + b.workers.get(k)!.length, 0);
    if (workerCount > 0) {
      header(`cluster:${system}:workers`, "workers", "●", 1, workerCount);
      if (!ctx.collapsedSections.has(`cluster:${system}:workers`)) {
        for (const ek of epicKeys) group(`cluster:${system}:workers:${ek || "(none)"}`, epicLabel(ek), "◈", 2, b.workers.get(ek)!);
      }
    }
  }
  // No-system sessions — one trailing top-level group (flat, no epic/role split).
  const none = bySystem.get("");
  if (none) {
    const rowsIn = [...none.workers.values(), ...none.core.values()].flat();
    group("cluster::none", "(no system)", "·", 0, rowsIn);
  }
  return items;
}
