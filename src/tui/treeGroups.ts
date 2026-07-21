import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { DisplayItem } from "./groupByProject.ts";

/**
 * The constellation view: sessions arranged by their catalogue parent→child edges (coordinator →
 * workers, loop-manager → loops, …). Only sessions that are part of a constellation appear —
 * a session with no parent and no children is standalone and lives in the state/flat views, not
 * here. Roots sort by subtree cost (biggest fleets first); children by their own subtree cost.
 */
export interface TreeCtx {
  catMap: ReadonlyMap<string, CatalogueRow>;
  /** A row's total spend (own + subagent rollup) — the per-node cost that subtrees sum. */
  costOf: (row: SessionRow) => number;
}

export function buildTreeItems(rows: readonly SessionRow[], ctx: TreeCtx): DisplayItem[] {
  const rowById = new Map(rows.map((r) => [r.sessionId, r]));

  const allParentIds = new Set<string>();
  for (const row of ctx.catMap.values()) {
    if (row.parentSessionId) allParentIds.add(row.parentSessionId);
  }

  // Catalogue child edges, restricted to sessions that are actually visible.
  const childIds = new Map<string, string[]>();
  for (const r of rows) {
    const parent = ctx.catMap.get(r.sessionId)?.parentSessionId ?? null;
    if (parent && rowById.has(parent)) {
      (childIds.get(parent) ?? childIds.set(parent, []).get(parent)!).push(r.sessionId);
    }
  }

  // Roots: constellation members (a parent, or a child) whose own parent isn't a visible row.
  const isMember = (id: string): boolean =>
    allParentIds.has(id) || childIds.has(id) || (() => {
      const p = ctx.catMap.get(id)?.parentSessionId ?? null;
      return !!p && rowById.has(p);
    })();

  // costOf is already the authoritative recursive causal/native total. Never sum child totals
  // again here or a visible child would be counted once in its parent and once as a row.
  const subtreeCost = (id: string): number => {
    const row = rowById.get(id);
    return row ? ctx.costOf(row) : 0;
  };

  let roots: string[] = [];
  for (const r of rows) {
    if (!isMember(r.sessionId)) continue;
    const p = ctx.catMap.get(r.sessionId)?.parentSessionId ?? null;
    if (!p || !rowById.has(p)) roots.push(r.sessionId);
  }
  if (roots.length === 0) roots = rows.filter((row) => isMember(row.sessionId)).map((row) => row.sessionId);
  roots.sort((a, b) => subtreeCost(b) - subtreeCost(a));

  const items: DisplayItem[] = [];
  const visited = new Set<string>();
  const walk = (id: string, depth: number): void => {
    if (visited.has(id)) return; // guard against cycles / diamond edges
    visited.add(id);
    const row = rowById.get(id);
    if (!row) return;
    const kids = (childIds.get(id) ?? []).slice().sort((a, b) => subtreeCost(b) - subtreeCost(a));
    items.push({
      kind: "session",
      row,
      depth,
      childCount: kids.length,
      expanded: kids.length > 0,
      subtreeCost: kids.length > 0 || subtreeCost(id) > row.costUSD ? subtreeCost(id) : undefined,
    });
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return items;
}
