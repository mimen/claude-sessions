import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import { lifecycleOf } from "../catalogue/db.ts";
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
  openSet: ReadonlySet<string>;
  collapsedSections: ReadonlySet<string>;
  expandedSessions?: ReadonlySet<string>;
  childCounts?: ReadonlyMap<string, number>;
  childrenByParent?: ReadonlyMap<string, SessionRow[]>;
  sort?: SortMode;
  costOf?: (row: SessionRow) => number;
}

/** Section key encodes system + tier + role so collapse state is stable + unique. */
function sectionKey(system: string, tier: "core" | "fleet", role: string): string {
  return `cluster:${system}:${tier}:${role}`;
}

export function buildClusterView(rows: readonly SessionRow[], ctx: ClusterViewCtx): DisplayItem[] {
  const expandedSessions = ctx.expandedSessions ?? new Set<string>();
  const childCounts = ctx.childCounts ?? new Map<string, number>();
  const childrenByParent = ctx.childrenByParent ?? new Map<string, SessionRow[]>();
  const sort = ctx.sort ?? "recent";
  const costOf = ctx.costOf ?? (() => 0);

  // Bucket rows by system -> role. A session with no system goes to the "" (none) system.
  const bySystem = new Map<string, Map<string, SessionRow[]>>();
  for (const row of rows) {
    const cat = ctx.catMap.get(row.sessionId) ?? null;
    const system = cat?.system ?? "";
    const role = cat?.skill ?? "(unroled)";
    const roles = bySystem.get(system) ?? bySystem.set(system, new Map()).get(system)!;
    (roles.get(role) ?? roles.set(role, []).get(role)!).push(row);
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

  const emitRole = (system: string, tier: "core" | "fleet", role: string, rowsIn: SessionRow[]): void => {
    if (rowsIn.length === 0) return;
    const key = sectionKey(system, tier, role);
    const collapsed = ctx.collapsedSections.has(key);
    const label = tier === "core" ? `${role}  ★` : role;
    const section: SectionMeta = { key, name: `${system || "(no system)"} · ${label}`, glyph: tier === "core" ? "★" : "●" };
    const cost = rowsIn.reduce((sum, r) => sum + costOf(r), 0);
    items.push({ kind: "section", section, count: rowsIn.length, collapsed, cost });
    if (!collapsed) for (const r of sortRows(rowsIn, sort, costOf)) pushSession(r, 0);
  };

  // Real systems first (alphabetical, but the primary "pr-watch" naturally sorts among them),
  // then the "(no system)" bucket last.
  const systems = [...bySystem.keys()].filter((s) => s !== "").sort();
  for (const system of systems) {
    const roles = bySystem.get(system)!;
    // Core roles first, in a fixed order.
    for (const role of CORE_ORDER) {
      if (roles.has(role)) { emitRole(system, "core", role, roles.get(role)!); roles.delete(role); }
    }
    // Then fleet roles alphabetically.
    for (const role of [...roles.keys()].sort()) {
      const tier = CORE_ROLES.has(role) ? "core" : "fleet";
      emitRole(system, tier, role, roles.get(role)!);
    }
  }
  // Sessions with no system (everything not in a cluster) — trailing bucket.
  const none = bySystem.get("");
  if (none) {
    for (const role of [...none.keys()].sort()) emitRole("", "fleet", role, none.get(role)!);
  }
  return items;
}
