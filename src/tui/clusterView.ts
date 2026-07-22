import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow, Lifecycle } from "../catalogue/db.ts";
import { lifecycleOf } from "../catalogue/db.ts";
import { isCoreRole } from "../catalogue/cluster-map.ts";
import type { EpicDisplay } from "../state/groupings.ts";
import { groupByProject, sortRows, type DisplayItem, type SectionMeta, type SortMode } from "./groupByProject.ts";

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

/** Core/fleet membership is decided by isCoreRole (the single source of truth in
 * cluster-map.ts) so the TUI and `ccs cluster` never diverge. Clean labels (ADR-0015). */
// ADR-D3 (2026-07-14): the trailing legacy pr-watch-* aliases were dead code — they were
// leftovers from an earlier naming pass and could misclassify a second cluster's sessions.
const CORE_ORDER = ["control", "concierge", "slack-scout", "eval", "designer", "loop-designer", "scout"];

export interface ClusterViewCtx {
  catMap: ReadonlyMap<string, CatalogueRow>;
  epicMap: ReadonlyMap<string, EpicDisplay>;
  openSet: ReadonlySet<string>;
  collapsedSections: ReadonlySet<string>;
  expandedSessions?: ReadonlySet<string>;
  childCounts?: ReadonlyMap<string, number>;
  childrenByParent?: ReadonlyMap<string, SessionRow[]>;
  sort?: SortMode;
  costOf?: (row: SessionRow) => number;
}

/**
 * Cluster view structure: for each system, TWO tiers —
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
    const system = cat?.cluster ?? "";
    const role = cat?.role ?? "(unroled)";
    const b = bySystem.get(system) ?? bySystem.set(system, { core: new Map(), workers: new Map() }).get(system)!;
    if (isCoreRole(role)) {
      (b.core.get(role) ?? b.core.set(role, []).get(role)!).push(row);
    } else {
      const epicKey = cat?.groupingId ?? ""; // "" = no epic
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

  // Collapse semantics: presence in collapsedSections = collapsed. EXCEPTION: `:done`
  // folds default to COLLAPSED (finished work stays hidden until opened), so for them
  // "open" is the explicit signal — we store an `open:<key>` marker when expanded.
  const isCollapsed = (key: string): boolean =>
    key.endsWith(":done")
      ? !ctx.collapsedSections.has(`open:${key}`)
      : ctx.collapsedSections.has(key);

  /** Emit a nested header at `level` (0 cluster, 1 core/workers tier, 2 epic/role). */
  const header = (key: string, name: string, glyph: string, level: number, count: number): void => {
    items.push({ kind: "section", section: { key, name, glyph, level }, count, collapsed: isCollapsed(key), cost: 0 });
  };

  const isRetired = (r: SessionRow): boolean => {
    const lc = lifecycleOf(ctx.catMap.get(r.sessionId) ?? null);
    return lc === "completed" || lc === "archived";
  };

  /** A leaf group (epic or role) at `level`: its sub-header, then LIVE sessions directly,
   * with retired (completed/archived) ones folded into a collapsible "✓ done · N" sub-line
   * (collapsed by default) so finished work doesn't crowd the active fleet. */
  const group = (key: string, name: string, glyph: string, level: number, rowsIn: SessionRow[]): void => {
    if (rowsIn.length === 0) return;
    header(key, name, glyph, level, rowsIn.length);
    if (isCollapsed(key)) return;
    const live = rowsIn.filter((r) => !isRetired(r));
    const retired = rowsIn.filter(isRetired);
    for (const r of sortRows(live, sort, costOf)) pushSession(r, level);
    if (retired.length > 0) {
      // Nested "done" fold at level+1. Collapsed by DEFAULT (its key is seeded into the
      // default-collapsed set) so finished work is hidden until expanded; shown when the
      // user opens it.
      const doneKey = `${key}:done`;
      header(doneKey, "done", "✓", level + 1, retired.length);
      if (!isCollapsed(doneKey)) {
        for (const r of sortRows(retired, sort, costOf)) pushSession(r, level + 1);
      }
    }
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
    if (isCollapsed(`cluster:${system}`)) continue;

    // LEVEL 1 — CORE tier: a flat list under one header. The hierarchy already conveys that
    // every child is a core role, so neither a star suffix nor per-role subgroups add signal.
    const coreRoles = [...CORE_ORDER.filter((r) => b.core.has(r)),
      ...[...b.core.keys()].filter((r) => !CORE_ORDER.includes(r)).sort()];
    const coreRows = coreRoles.flatMap((r) => b.core.get(r)!);
    if (coreRows.length > 0) group(`cluster:${system}:core`, "core", " ", 1, coreRows);

    // LEVEL 1 — WORKERS tier. Epic subgroups only earn a row when they actually partition the
    // fleet. A single all-unassigned bucket is just an extra indentation layer, not information.
    const epicKeys = [...b.workers.keys()].sort((a, z) => {
      if ((a === "") !== (z === "")) return a === "" ? 1 : -1;
      const d = b.workers.get(z)!.length - b.workers.get(a)!.length;
      return d !== 0 ? d : epicLabel(a).localeCompare(epicLabel(z));
    });
    const workerCount = epicKeys.reduce((n, k) => n + b.workers.get(k)!.length, 0);
    if (workerCount > 0) {
      const workersKey = `cluster:${system}:workers`;
      header(workersKey, "workers", "●", 1, workerCount);
      if (!isCollapsed(workersKey)) {
        if (epicKeys.length === 1 && epicKeys[0] === "") {
          const unassigned = b.workers.get("")!;
          const live = unassigned.filter((r) => !isRetired(r));
          const retired = unassigned.filter(isRetired);
          for (const r of sortRows(live, sort, costOf)) pushSession(r, 1);
          if (retired.length > 0) {
            const doneKey = `${workersKey}:done`;
            header(doneKey, "done", "✓", 2, retired.length);
            if (!isCollapsed(doneKey)) {
              for (const r of sortRows(retired, sort, costOf)) pushSession(r, 2);
            }
          }
        } else {
          for (const ek of epicKeys) {
            group(`cluster:${system}:workers:${ek || "(none)"}`, epicLabel(ek), "◈", 2, b.workers.get(ek)!);
          }
        }
      }
    }
  }
  // No-system sessions — the "stray" bucket. Unlike a cluster group (one merged retired
  // fold), strays are sub-grouped by LIFECYCLE into open / parked / done / archived so the
  // loose tail is legible on its own terms. `open` = the idle lifecycle (active is just an
  // idle session with a live terminal, still shown by the per-row dot); `parked` leads
  // alongside it expanded; `done` (completed) and `archived` collapse by default — done via
  // the `:done` inversion, archived via a DEFAULT_COLLAPSED seed on `cluster::none:archived`.
  const none = bySystem.get("");
  if (none) {
    const strays = [...none.workers.values(), ...none.core.values()].flat();
    if (strays.length > 0) {
      header("cluster::none", "(no system)", "·", 0, strays.length);
      if (!isCollapsed("cluster::none")) {
        const lc = (r: SessionRow): Lifecycle => lifecycleOf(ctx.catMap.get(r.sessionId) ?? null);
        const subGroup = (suffix: string, name: string, glyph: string, state: Lifecycle): void => {
          const rowsIn = strays.filter((r) => lc(r) === state);
          if (rowsIn.length === 0) return;
          const key = `cluster::none:${suffix}`;
          header(key, name, glyph, 1, rowsIn.length);
          if (!isCollapsed(key)) for (const r of sortRows(rowsIn, sort, costOf)) pushSession(r, 1);
        };
        // `open` (active + idle) is the dominant bucket — hundreds of loose sessions — so it
        // is further grouped BY PROJECT at level 2 rather than listed flat. Project groups
        // render expanded (labelled separators, every row still visible) and stay individually
        // collapsible. Rows are sorted first so both the project order and the rows inside each
        // follow the active sort, matching groupByProject's preserve-input-order contract.
        const openRows = strays.filter((r) => lc(r) === "idle");
        if (openRows.length > 0) {
          const openKey = "cluster::none:open";
          header(openKey, "open", "○", 1, openRows.length);
          if (!isCollapsed(openKey)) {
            for (const g of groupByProject(sortRows(openRows, sort, costOf))) {
              const projectKey = `${openKey}:${g.root}`;
              header(projectKey, g.name, "◈", 2, g.sessions.length);
              if (!isCollapsed(projectKey)) for (const r of g.sessions) pushSession(r, 2);
            }
          }
        }
        subGroup("parked", "parked", "⏸", "parked");
        subGroup("done", "done", "✓", "completed"); // `:done` → collapsed by default
        subGroup("archived", "archived", "·", "archived"); // seeded collapsed in DEFAULT_COLLAPSED
      }
    }
  }
  return items;
}
