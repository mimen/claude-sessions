import type { SessionRow } from "./index.ts";

/** A durable causal edge supplied by the catalogue. */
export interface CausalEdge {
  readonly sessionId: string;
  readonly parentId: string;
}

export type ProviderFamily = "claude" | "gpt" | "other";

export interface CostBreakdown {
  readonly claude: number;
  readonly gpt: number;
  readonly other: number;
}

export interface SessionCostRollup {
  /** Cost of the transcript represented by this indexed row alone. */
  readonly selfCost: number;
  /** Cost of this transcript and every causal/native descendant, counted once. */
  readonly totalCost: number;
  /** Total cost grouped from observed transcript model ids. */
  readonly byProvider: CostBreakdown;
  /** Number of unique physical descendant transcripts included in totalCost. */
  readonly descendantCount: number;
  /** Physical indexed session ids in this recursive closure, including the root. */
  readonly physicalSessionIds: ReadonlySet<string>;
}

export interface CostRollup {
  readonly bySessionId: ReadonlyMap<string, SessionCostRollup>;
  /** Physical store spend: each indexed transcript row exactly once. */
  readonly physicalStoreCost: number;
}

const EMPTY_BREAKDOWN: CostBreakdown = { claude: 0, gpt: 0, other: 0 };

/** Classify observed model ids without relying on requested launch metadata. */
export function providerFamily(model: string): ProviderFamily {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("claude-")) return "claude";
  if (normalized.includes("gpt") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4")) return "gpt";
  return "other";
}

function breakdownFor(row: SessionRow): CostBreakdown {
  const out: { claude: number; gpt: number; other: number } = { ...EMPTY_BREAKDOWN };
  for (const [model, cost] of Object.entries(row.costByModel)) {
    out[providerFamily(model)] += cost;
  }
  // Some old/corrupt transcript rows have scalar cost but no model map. Preserve their cost.
  const classified = out.claude + out.gpt + out.other;
  if (row.costUSD > classified) out.other += row.costUSD - classified;
  return out;
}

function addBreakdowns(left: CostBreakdown, right: CostBreakdown): CostBreakdown {
  return {
    claude: left.claude + right.claude,
    gpt: left.gpt + right.gpt,
    other: left.other + right.other,
  };
}

/**
 * Build the one authoritative causal cost closure. Native transcript sidechains and catalogue
 * causal edges share one alias-normalized graph; a DFS-local seen set makes mixed edges and
 * cycles harmless while retaining each physical transcript exactly once per owning root.
 */
export function buildCostRollup(rows: readonly SessionRow[], causalEdges: readonly CausalEdge[]): CostRollup {
  const rowById = new Map<string, SessionRow>();
  const aliasToId = new Map<string, string>();
  for (const row of rows) {
    rowById.set(row.sessionId, row);
    aliasToId.set(row.sessionId, row.sessionId);
    aliasToId.set(row.resumeId, row.sessionId);
  }

  // Catalogue-only automation anchors have no transcript row of their own. Preserve them as
  // zero-self-cost graph roots so their delegated children still roll up in tree/cost views.
  const syntheticRoots = new Set<string>();
  for (const edge of causalEdges) {
    if (!aliasToId.has(edge.parentId)) {
      aliasToId.set(edge.parentId, edge.parentId);
      syntheticRoots.add(edge.parentId);
    }
  }

  const children = new Map<string, Set<string>>();
  const addEdge = (parentAlias: string, childAlias: string): void => {
    const parent = aliasToId.get(parentAlias);
    const child = aliasToId.get(childAlias);
    if (!parent || !child || parent === child) return;
    const set = children.get(parent) ?? new Set<string>();
    set.add(child);
    children.set(parent, set);
  };

  for (const row of rows) {
    if (row.isSubagent && row.parentSessionId) addEdge(row.parentSessionId, row.sessionId);
  }
  for (const edge of causalEdges) addEdge(edge.parentId, edge.sessionId);

  const self = new Map<string, CostBreakdown>();
  for (const row of rows) self.set(row.sessionId, breakdownFor(row));

  const bySessionId = new Map<string, SessionCostRollup>();
  const roots = [...rows.map((row) => row.sessionId), ...syntheticRoots];
  for (const rootId of roots) {
    const seen = new Set<string>();
    const visit = (id: string): CostBreakdown => {
      if (seen.has(id)) return EMPTY_BREAKDOWN;
      seen.add(id);
      let total = self.get(id) ?? EMPTY_BREAKDOWN;
      for (const child of children.get(id) ?? []) total = addBreakdowns(total, visit(child));
      return total;
    };
    const total = visit(rootId);
    const physicalSessionIds = new Set([...seen].filter((id) => rowById.has(id)));
    const indexedRoot = rowById.get(rootId);
    bySessionId.set(rootId, {
      selfCost: indexedRoot?.costUSD ?? 0,
      totalCost: total.claude + total.gpt + total.other,
      byProvider: total,
      descendantCount: indexedRoot
        ? Math.max(0, physicalSessionIds.size - 1)
        : physicalSessionIds.size,
      physicalSessionIds,
    });
  }

  return {
    bySessionId,
    physicalStoreCost: rows.reduce((sum, row) => sum + row.costUSD, 0),
  };
}
