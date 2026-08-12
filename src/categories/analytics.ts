import type { Database } from "bun:sqlite";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getAll, lifecycleOf, parentEdges } from "../catalogue/db-queries.ts";
import { isIncognito } from "../catalogue/incognito.ts";
import { formatCost } from "../cost.ts";
import { listByRecency } from "../index/index.ts";
import { buildCostRollup } from "../index/cost-rollup.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { getAllCategoryAssignments, resolveEffectiveCategory } from "./assignment.ts";
import { loadCategoryRegistry } from "./registry.ts";
import { CATEGORY_REGISTRY_PATH } from "../paths.ts";

export const CATEGORY_ANALYTICS_SCHEMA_VERSION = 1;

export interface CategoryAnalyticsGroup {
  readonly slug: string | null;
  readonly label: string;
  readonly retainedSessions: number;
  readonly rootSessions: number;
  readonly active: number;
  readonly saved: number;
  readonly done: number;
  readonly messages: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly rootCostUsd: number;
}

export interface CategoryAnalytics {
  readonly schema: typeof CATEGORY_ANALYTICS_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly exclusions: readonly ["auxiliary", "native-subagent", "workflow-journal"];
  readonly costSemantics: "recursive cost once per displayed retained root";
  readonly groups: readonly CategoryAnalyticsGroup[];
}

export function buildCategoryAnalytics(index: Database, catalogue: Database, now: string): CategoryAnalytics {
  const indexed = listByRecency(index, true);
  const rows = getAll(catalogue);
  const edges = parentEdges(catalogue);
  const parents = new Map(edges.map((edge) => [edge.sessionId, edge.parentId] as const));
  const assignments = getAllCategoryAssignments(catalogue);
  const classes = new Map([...rows].map(([id, row]) => [id, row.sessionClass] as const));
  const known = new Set([...rows.keys(), ...indexed.map((row) => row.sessionId)]);
  const eligible = indexed.filter((row) => {
    const stored = rows.get(row.sessionId);
    return !row.isSubagent
      && !isIncognito(stored)
      && stored?.sessionClass !== "auxiliary"
      && stored?.meta.workflowJournal !== true
      && stored?.meta.workflow_journal !== true
      && stored?.meta.journal !== true;
  });
  const eligibleIds = new Set(eligible.map((row) => row.sessionId));
  const rollup = buildCostRollup(indexed, edges);
  const registry = loadCategoryRegistry(CATEGORY_REGISTRY_PATH());
  const labels = registry.ok
    ? new Map(registry.value.categories.map((category) => [category.slug, category.name] as const))
    : new Map<string, string>();
  const groups = new Map<string, CategoryAnalyticsGroup>();
  const isDisplayedRoot = (sessionId: string): boolean => {
    const visited = new Set<string>([sessionId]);
    let current = parents.get(sessionId);
    while (current && !visited.has(current)) {
      if (eligibleIds.has(current)) return false;
      visited.add(current);
      current = parents.get(current);
    }
    return true;
  };
  for (const row of eligible) {
    const effective = resolveEffectiveCategory(row.sessionId, assignments, parents, known, classes);
    const key = effective.slug ?? "__uncategorized__";
    const current = groups.get(key) ?? {
      slug: effective.slug,
      label: effective.slug ? labels.get(effective.slug) ?? `Invalid: ${effective.slug}` : "Uncategorized",
      retainedSessions: 0,
      rootSessions: 0,
      active: 0,
      saved: 0,
      done: 0,
      messages: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      rootCostUsd: 0,
    };
    const lifecycle = lifecycleOf(rows.get(row.sessionId) ?? null);
    const root = isDisplayedRoot(row.sessionId);
    groups.set(key, {
      ...current,
      retainedSessions: current.retainedSessions + 1,
      rootSessions: current.rootSessions + (root ? 1 : 0),
      active: current.active + (lifecycle === "idle" || lifecycle === "parked" ? 1 : 0),
      saved: current.saved + (lifecycle === "saved" ? 1 : 0),
      done: current.done + (lifecycle === "completed" || lifecycle === "archived" ? 1 : 0),
      messages: current.messages + row.msgCount,
      inputTokens: current.inputTokens + row.tokInput,
      outputTokens: current.outputTokens + row.tokOutput,
      cacheReadTokens: current.cacheReadTokens + row.tokCacheRead,
      cacheWriteTokens: current.cacheWriteTokens + row.tokCacheWrite,
      rootCostUsd: current.rootCostUsd + (root ? rollup.bySessionId.get(row.sessionId)?.totalCost ?? row.costUSD : 0),
    });
  }
  const order = registry.ok
    ? new Map(registry.value.categories.map((category) => [category.slug, category.order] as const))
    : new Map<string, number>();
  return {
    schema: CATEGORY_ANALYTICS_SCHEMA_VERSION,
    generatedAt: now,
    exclusions: ["auxiliary", "native-subagent", "workflow-journal"],
    costSemantics: "recursive cost once per displayed retained root",
    groups: [...groups.values()].sort((a, b) =>
      (a.slug ? order.get(a.slug) ?? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER)
      - (b.slug ? order.get(b.slug) ?? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER)
      || a.label.localeCompare(b.label)),
  };
}

export function categoryAnalyticsCommand(args: readonly string[]): number {
  if (args[0] !== "analytics" || args.some((arg) => arg !== "analytics" && arg !== "--json")) {
    console.error("usage: ccs category analytics [--json]");
    return 2;
  }
  ensureDataDir();
  const index = openIndex(DB_PATH());
  const catalogue = openCatalogue(CATALOGUE_PATH());
  try {
    const result = buildCategoryAnalytics(index, catalogue, new Date().toISOString());
    if (args.includes("--json")) {
      console.log(JSON.stringify(result));
      return 0;
    }
    console.log("Category analytics (retained roots; auxiliary/native-subagent/workflow-journal rows excluded)");
    for (const group of result.groups) {
      console.log(`${group.label}\t${group.rootSessions} roots\t${group.retainedSessions} sessions\t${formatCost(group.rootCostUsd) || "$0"}\t${group.messages} messages\t${group.active} Active/${group.saved} Saved/${group.done} Done`);
    }
    return 0;
  } finally {
    index.close();
    catalogue.close();
  }
}
