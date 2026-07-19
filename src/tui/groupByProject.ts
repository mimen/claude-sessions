import type { SessionRow } from "../index/index.ts";

export interface ProjectGroup {
  readonly root: string;
  readonly name: string;
  readonly sessions: SessionRow[];
}

/**
 * Group rows by Project, preserving input order. Since rows arrive most-recent-first, the
 * most-recently-active Project comes first and each group's sessions stay recency-ordered.
 */
export function groupByProject(rows: readonly SessionRow[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const order: string[] = [];
  for (const row of rows) {
    let group = groups.get(row.projectRoot);
    if (!group) {
      group = { root: row.projectRoot, name: row.projectName, sessions: [] };
      groups.set(row.projectRoot, group);
      order.push(row.projectRoot);
    }
    group.sessions.push(row);
  }
  return order.map((root) => groups.get(root)!);
}

/** A state-grouping section header (Active / Loops / Parked / …). */
export interface SectionMeta {
  readonly key: string;
  readonly name: string;
  readonly glyph: string;
  /** Nesting depth for hierarchical headers (0 = top-level). Renderer indents by this. */
  readonly level?: number;
}

/** List ordering within a section (and in the flat view). */
export type SortMode = "recent" | "cost" | "msgs";

/**
 * Order rows for display. Rows arrive recency-first from the Index, so "recent" is a no-op.
 * `costOf` returns a row's total spend (own + subagent rollup) so cost-sort matches the column.
 */
export function sortRows(
  rows: readonly SessionRow[],
  mode: SortMode,
  costOf: (r: SessionRow) => number,
): SessionRow[] {
  if (mode === "recent") return rows.slice();
  const arr = rows.slice();
  if (mode === "cost") arr.sort((a, b) => costOf(b) - costOf(a));
  else arr.sort((a, b) => b.msgCount - a.msgCount);
  return arr;
}

/** A navigable row in the list: a Project header, a state Section header, or a Session. */
export type DisplayItem =
  | { readonly kind: "header"; readonly group: ProjectGroup; readonly expanded: boolean }
  | {
      readonly kind: "section";
      readonly section: SectionMeta;
      readonly count: number;
      readonly collapsed: boolean;
      /** Total spend of the sessions in this section (own + subagent rollup). */
      readonly cost: number;
    }
  | {
      readonly kind: "session";
      readonly row: SessionRow;
      readonly depth: number;
      /** Number of subagent runs this Session spawned (0 if none). */
      readonly childCount: number;
      /** Whether this Session's subagents are currently expanded inline. */
      readonly expanded: boolean;
      /** Constellation subtree cost (own + all descendants) — only set in the tree view. */
      readonly subtreeCost?: number;
      /** Live open-state, shown as an active/idle dot — only set in the groups view. */
      readonly openState?: "open" | "idle";
    };

/** State controlling what is expanded, and the children to inline when a Session is open. */
export interface ExpansionState {
  expandedGroups?: ReadonlySet<string>;
  expandedSessions?: ReadonlySet<string>;
  /** sessionId → number of subagent runs (for the expand affordance). */
  childCounts?: ReadonlyMap<string, number>;
  /** parentSessionId → its subagent rows (only needs entries for expanded Sessions). */
  childrenByParent?: ReadonlyMap<string, SessionRow[]>;
  /** Ordering of the flat list (default: recency). */
  sort?: SortMode;
  /** A row's total spend (own + subagent rollup) — drives cost-sort. */
  costOf?: (row: SessionRow) => number;
}

/** Flatten rows/groups into the linear list the UI navigates, per view mode. */
export function buildDisplayItems(
  rows: readonly SessionRow[],
  grouped: boolean,
  exp: ExpansionState = {},
): DisplayItem[] {
  const expandedGroups = exp.expandedGroups ?? new Set<string>();
  const expandedSessions = exp.expandedSessions ?? new Set<string>();
  const childCounts = exp.childCounts ?? new Map<string, number>();
  const childrenByParent = exp.childrenByParent ?? new Map<string, SessionRow[]>();
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

  if (!grouped) {
    const ordered = exp.sort ? sortRows(rows, exp.sort, exp.costOf ?? (() => 0)) : rows;
    for (const row of ordered) pushSession(row, 0);
    return items;
  }
  for (const group of groupByProject(rows)) {
    const isOpen = expandedGroups.has(group.root);
    items.push({ kind: "header", group, expanded: isOpen });
    if (isOpen) for (const row of group.sessions) pushSession(row, 1);
  }
  return items;
}
