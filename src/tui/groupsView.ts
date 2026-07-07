import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";
import type { DisplayItem, SectionMeta } from "./groupByProject.ts";

/**
 * The groups view: named constellations as sibling top-level groups, then LOOPS (standalone
 * loops not in any constellation), then SOLO (everything else). A session that belongs to a
 * constellation appears ONLY under that constellation — never in loops/solo. Within a group,
 * sessions are age-ordered and carry an active/idle dot (open in cmux or not).
 *
 * A constellation is a connected component of the catalogue parent→child graph; its NAME is the
 * root session's backing skill (e.g. `event-watch`), falling back to the root's title.
 */
export interface GroupsCtx {
  catMap: ReadonlyMap<string, CatalogueRow>;
  openSet: ReadonlySet<string>;
  collapsedSections: ReadonlySet<string>;
  /** Nodes the user has explicitly expanded to reveal their (deeper) children. */
  expandedSessions?: ReadonlySet<string>;
}

const CONSTELLATION_GLYPH = "◇";
const PROJECT_GLYPH = "▢";
// Constellation depth shown by default (0 = root, 1 = its direct children); deeper is collapsed.
const AUTO_DEPTH = 1;

function cleanName(t: string): string {
  return t.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

export function buildGroupsView(rows: readonly SessionRow[], ctx: GroupsCtx): DisplayItem[] {
  const rowById = new Map(rows.map((r) => [r.sessionId, r]));
  const parentOf = (id: string): string | null => {
    const p = ctx.catMap.get(id)?.parentSessionId ?? null;
    return p && rowById.has(p) ? p : null;
  };
  const hasChild = new Set<string>();
  const childIds = new Map<string, string[]>();
  for (const r of rows) {
    const p = parentOf(r.sessionId);
    if (p) {
      hasChild.add(p);
      (childIds.get(p) ?? childIds.set(p, []).get(p)!).push(r.sessionId);
    }
  }

  // Root of a session's constellation (walk parent chain); null if it's standalone.
  const rootOf = (id: string): string | null => {
    let cur = id;
    const seen = new Set<string>();
    let inConstellation = hasChild.has(id) || parentOf(id) !== null;
    while (true) {
      if (seen.has(cur)) break; // cycle guard
      seen.add(cur);
      const p = parentOf(cur);
      if (!p) break;
      cur = p;
      inConstellation = true;
    }
    return inConstellation ? cur : null;
  };

  // Bucket rows: constellation-root-id, or the pseudo-groups "loops" / "solo".
  const buckets = new Map<string, SessionRow[]>();
  const order: string[] = [];
  const push = (key: string, row: SessionRow) => {
    let b = buckets.get(key);
    if (!b) {
      b = [];
      buckets.set(key, b);
      order.push(key);
    }
    b.push(row);
  };
  for (const r of rows) {
    const root = rootOf(r.sessionId);
    const project = ctx.catMap.get(r.sessionId)?.project ?? null;
    if (root) push(`c:${root}`, r);
    else if (project) push(`p:${project}`, r);
    else if (ctx.catMap.get(r.sessionId)?.kind === "loop") push("loops", r);
    else push("solo", r);
  }

  const ageOf = (r: SessionRow): number => (r.lastTs ? Date.parse(r.lastTs) : 0);
  const recency = (key: string): number => Math.max(0, ...(buckets.get(key)?.map(ageOf) ?? [0]));

  // Section order: constellations, then projects (each most-recently-active first), then loops, solo.
  const constKeys = order.filter((k) => k.startsWith("c:")).sort((a, b) => recency(b) - recency(a));
  const projKeys = order.filter((k) => k.startsWith("p:")).sort((a, b) => recency(b) - recency(a));
  const sectionKeys = [
    ...constKeys,
    ...projKeys,
    ...(buckets.has("loops") ? ["loops"] : []),
    ...(buckets.has("solo") ? ["solo"] : []),
  ];

  const metaFor = (key: string): SectionMeta => {
    if (key === "loops") return { key: "loops", name: "LOOPS", glyph: "◆" };
    if (key === "solo") return { key: "solo", name: "SOLO", glyph: "·" };
    if (key.startsWith("p:")) return { key, name: key.slice(2).toUpperCase(), glyph: PROJECT_GLYPH };
    const rootId = key.slice(2);
    const root = rowById.get(rootId);
    const name = ctx.catMap.get(rootId)?.skill ?? (root ? cleanName(root.title) : rootId);
    return { key, name: name.toUpperCase(), glyph: CONSTELLATION_GLYPH };
  };

  // Don't fold SOLO when it's the only group (else a user with no constellations sees nothing).
  const soloOnly = sectionKeys.length === 1;

  const expanded = ctx.expandedSessions ?? new Set<string>();

  // Depth-first walk of a constellation. A node's children show if it's within AUTO_DEPTH or the
  // user expanded it; otherwise the node is collapsed (▸) with its subtree hidden.
  const walk = (items: DisplayItem[], id: string, depth: number, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const row = rowById.get(id);
    if (!row) return;
    const kids = (childIds.get(id) ?? []).slice().sort((a, b) => ageOf(rowById.get(b)!) - ageOf(rowById.get(a)!));
    const showKids = kids.length > 0 && (depth < AUTO_DEPTH || expanded.has(id));
    items.push({
      kind: "session",
      row,
      depth,
      childCount: kids.length,
      expanded: showKids,
      openState: ctx.openSet.has(row.sessionId) ? "open" : "idle",
    });
    if (showKids) for (const kid of kids) walk(items, kid, depth + 1, seen);
  };

  const items: DisplayItem[] = [];
  for (const key of sectionKeys) {
    const rowsIn = buckets.get(key) ?? [];
    const collapsed = !soloOnly && ctx.collapsedSections.has(key);
    items.push({ kind: "section", section: metaFor(key), count: rowsIn.length, collapsed, cost: 0 });
    if (collapsed) continue;
    if (key.startsWith("c:")) {
      // Constellation: render the hierarchy (root → descendants), not a flat list.
      walk(items, key.slice(2), 0, new Set());
    } else {
      // loops / solo: flat, age-ordered.
      for (const row of rowsIn.slice().sort((a, b) => ageOf(b) - ageOf(a))) {
        items.push({
          kind: "session",
          row,
          depth: 0,
          childCount: 0,
          expanded: false,
          openState: ctx.openSet.has(row.sessionId) ? "open" : "idle",
        });
      }
    }
  }
  return items;
}
