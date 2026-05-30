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

/** A navigable row in the list: either a Project header or a Session. */
export type DisplayItem =
  | { readonly kind: "header"; readonly group: ProjectGroup; readonly expanded: boolean }
  | { readonly kind: "session"; readonly row: SessionRow; readonly depth: number };

/** Flatten rows/groups into the linear list the UI navigates, per view mode. */
export function buildDisplayItems(
  rows: readonly SessionRow[],
  grouped: boolean,
  expanded: ReadonlySet<string>,
): DisplayItem[] {
  if (!grouped) {
    return rows.map((row) => ({ kind: "session", row, depth: 0 }));
  }
  const items: DisplayItem[] = [];
  for (const group of groupByProject(rows)) {
    const isOpen = expanded.has(group.root);
    items.push({ kind: "header", group, expanded: isOpen });
    if (isOpen) {
      for (const row of group.sessions) items.push({ kind: "session", row, depth: 1 });
    }
  }
  return items;
}
