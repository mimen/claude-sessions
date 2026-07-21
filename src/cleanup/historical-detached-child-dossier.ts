import type {
  CleanupEvidence,
  HistoricalDetachedChildFinding,
  HistoricalDetachedChildManifest,
  MatchStatus,
} from "./historical-detached-child-classifier.ts";

/** Read-only session details injected by the renderer from immutable index/catalogue queries. */
export interface HistoricalDetachedChildSessionContext {
  readonly sessionId: string;
  readonly aliases: readonly string[];
  readonly title: string | null;
  readonly project: string | null;
  readonly branch: string | null;
  readonly cwd: string | null;
  readonly lastActivityAt: string | null;
  readonly selfCostUSD: number | null;
  readonly sessionClass: "work_body" | "auxiliary" | null;
  readonly causalParentSessionId: string | null;
  readonly lifecycle: "idle" | "parked" | "completed" | "archived" | null;
  readonly tags: readonly string[];
}

export type HistoricalDetachedChildDossierCategory =
  | "exact_proposed"
  | "provider_mismatch"
  | "prompt_mismatch"
  | "model_mismatch"
  | "duplicate_claim"
  | "ambiguous"
  | "timestamp_or_cwd_mismatch"
  | "other_withheld";

export const DOSSIER_CATEGORY_ORDER: readonly HistoricalDetachedChildDossierCategory[] = [
  "exact_proposed",
  "provider_mismatch",
  "prompt_mismatch",
  "model_mismatch",
  "duplicate_claim",
  "ambiguous",
  "timestamp_or_cwd_mismatch",
  "other_withheld",
] as const;

export interface HistoricalDetachedChildSessionReference {
  /** ID exactly as it appeared in the report manifest. */
  readonly rawId: string;
  /** ID after resolving an index/catalogue alias, when available. */
  readonly canonicalId: string;
  readonly context: HistoricalDetachedChildSessionContext | null;
  readonly missingContext: boolean;
}

export interface HistoricalDetachedChildDossierProposal {
  readonly destination: "auxiliary";
  readonly sessionClass: "auxiliary";
  readonly causalParent: HistoricalDetachedChildSessionReference;
  readonly tags: readonly string[];
}

export interface HistoricalDetachedChildDossierFinding {
  readonly findingIndex: number;
  readonly category: HistoricalDetachedChildDossierCategory;
  readonly status: MatchStatus;
  readonly reason: string | null;
  readonly parent: HistoricalDetachedChildSessionReference | null;
  readonly candidates: readonly HistoricalDetachedChildSessionReference[];
  readonly proposal: HistoricalDetachedChildDossierProposal | null;
  readonly evidence: CleanupEvidence;
}

export interface HistoricalDetachedChildDossierCategoryGroup {
  readonly category: HistoricalDetachedChildDossierCategory;
  readonly findings: readonly HistoricalDetachedChildDossierFinding[];
}

export interface HistoricalDetachedChildDossierNode {
  readonly id: string;
  readonly reference: HistoricalDetachedChildSessionReference;
  readonly childIds: readonly string[];
  readonly directProposedChildCount: number;
  readonly descendantProposalCount: number;
  readonly totalFindingCount: number;
  readonly withheldFindingCount: number;
}

export interface HistoricalDetachedChildProposalGraph {
  readonly roots: readonly string[];
  readonly nodes: readonly HistoricalDetachedChildDossierNode[];
  readonly edges: readonly { readonly parentId: string; readonly childId: string }[];
  readonly denseParents: readonly string[];
  readonly disconnectedNodeIds: readonly string[];
  readonly cycles: readonly (readonly string[])[];
}

export interface HistoricalDetachedChildDossier {
  readonly version: 1;
  readonly mode: "report_only";
  readonly findings: readonly HistoricalDetachedChildDossierFinding[];
  readonly categories: readonly HistoricalDetachedChildDossierCategoryGroup[];
  readonly proposalGraph: HistoricalDetachedChildProposalGraph;
  readonly totals: {
    readonly findingCount: number;
    readonly proposalCount: number;
    readonly withheldCount: number;
    readonly rootCount: number;
  };
  readonly warnings: readonly string[];
}

/** Categorize a classifier finding without adding or weakening any matching evidence. */
export function classifyHistoricalDetachedChildFinding(
  finding: HistoricalDetachedChildFinding,
): HistoricalDetachedChildDossierCategory {
  if (finding.status === "proposed") return "exact_proposed";
  if (finding.status === "duplicate_claim") return "duplicate_claim";
  if (finding.status === "ambiguous") return "ambiguous";

  const reason = finding.reason?.toLowerCase() ?? "";
  if (reason.includes("provider mismatch")) return "provider_mismatch";
  if (reason.includes("exact launch prompt")) return "prompt_mismatch";
  if (reason.includes("model mismatch")) return "model_mismatch";
  if (reason.includes("timestamp") || reason.includes("cwd mismatch")) return "timestamp_or_cwd_mismatch";
  return "other_withheld";
}

/**
 * Create a deterministic, presentation-only graph of the existing report. The manifest
 * remains the evidence source; this function neither reads storage nor changes metadata.
 */
export function projectHistoricalDetachedChildDossier(
  manifest: HistoricalDetachedChildManifest,
  sessionContextsById: ReadonlyMap<string, HistoricalDetachedChildSessionContext>,
): HistoricalDetachedChildDossier {
  const aliasToCanonical = aliasesOf(sessionContextsById);
  const referenceFor = (rawId: string): HistoricalDetachedChildSessionReference => {
    const canonicalId = aliasToCanonical.get(rawId) ?? rawId;
    const context = sessionContextsById.get(canonicalId) ?? null;
    return { rawId, canonicalId, context, missingContext: context === null };
  };

  const findings = manifest.findings.map((finding, findingIndex) => projectFinding(finding, findingIndex, referenceFor));
  const categories = DOSSIER_CATEGORY_ORDER.map((category) => ({
    category,
    findings: findings.filter((finding) => finding.category === category),
  }));
  const proposalGraph = buildProposalGraph(findings, referenceFor);
  const warnings = proposalGraph.cycles.length > 0
    ? [`${proposalGraph.cycles.length} causal cycle${proposalGraph.cycles.length === 1 ? "" : "s"} retained as disconnected review group${proposalGraph.cycles.length === 1 ? "" : "s"}.`]
    : [];

  return {
    version: 1,
    mode: "report_only",
    findings,
    categories,
    proposalGraph,
    totals: {
      findingCount: findings.length,
      proposalCount: categories[0]!.findings.length,
      withheldCount: findings.length - categories[0]!.findings.length,
      rootCount: proposalGraph.roots.length,
    },
    warnings,
  };
}

function projectFinding(
  finding: HistoricalDetachedChildFinding,
  findingIndex: number,
  referenceFor: (rawId: string) => HistoricalDetachedChildSessionReference,
): HistoricalDetachedChildDossierFinding {
  const parent = finding.parentSessionId === null ? null : referenceFor(finding.parentSessionId);
  const proposal = finding.proposal === null
    ? null
    : {
      destination: "auxiliary" as const,
      sessionClass: "auxiliary" as const,
      causalParent: referenceFor(finding.proposal.causalParentSessionId),
      tags: [...finding.proposal.tags],
    };
  return {
    findingIndex,
    category: classifyHistoricalDetachedChildFinding(finding),
    status: finding.status,
    reason: finding.reason,
    parent,
    candidates: finding.candidateSessionIds.map(referenceFor),
    proposal,
    evidence: finding.evidence,
  };
}

function aliasesOf(
  contexts: ReadonlyMap<string, HistoricalDetachedChildSessionContext>,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const [id, context] of [...contexts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    out.set(id, id);
    out.set(context.sessionId, id);
    for (const alias of context.aliases) out.set(alias, id);
  }
  return out;
}

function buildProposalGraph(
  findings: readonly HistoricalDetachedChildDossierFinding[],
  referenceFor: (rawId: string) => HistoricalDetachedChildSessionReference,
): HistoricalDetachedChildProposalGraph {
  const nodeReferences = new Map<string, HistoricalDetachedChildSessionReference>();
  const childrenByParent = new Map<string, Set<string>>();
  const parentsByChild = new Map<string, Set<string>>();
  const findingCountByParent = new Map<string, number>();
  const withheldByParent = new Map<string, number>();

  for (const finding of findings) {
    if (finding.parent !== null) {
      nodeReferences.set(finding.parent.canonicalId, finding.parent);
      increment(findingCountByParent, finding.parent.canonicalId);
      if (finding.proposal === null) increment(withheldByParent, finding.parent.canonicalId);
    }
    if (finding.proposal === null) continue;
    const candidate = finding.candidates[0];
    if (candidate === undefined) continue;
    const parent = finding.proposal.causalParent;
    nodeReferences.set(parent.canonicalId, parent);
    nodeReferences.set(candidate.canonicalId, candidate);
    addToSet(childrenByParent, parent.canonicalId, candidate.canonicalId);
    addToSet(parentsByChild, candidate.canonicalId, parent.canonicalId);
  }

  const ids = [...nodeReferences.keys()].sort();
  const cycles = detectCycles(ids, childrenByParent);
  // A review root is an actual spawning parent with no proposed parent of its own.
  // Terminal children are leaves, not independent root review queues.
  const roots = ids.filter((id) => childrenByParent.has(id) && (parentsByChild.get(id)?.size ?? 0) === 0);
  const reachable = reachableFrom(roots, childrenByParent);
  const disconnectedNodeIds = ids.filter((id) => !reachable.has(id));
  const nodes = ids.map((id) => {
    const childIds = [...(childrenByParent.get(id) ?? new Set<string>())].sort();
    return {
      id,
      reference: nodeReferences.get(id) ?? referenceFor(id),
      childIds,
      directProposedChildCount: childIds.length,
      descendantProposalCount: descendantCount(id, childrenByParent),
      totalFindingCount: findingCountByParent.get(id) ?? 0,
      withheldFindingCount: withheldByParent.get(id) ?? 0,
    };
  });
  const denseParents = nodes
    .filter((node) => node.directProposedChildCount >= 4)
    .sort(compareDenseNode)
    .map((node) => node.id);
  const edges = nodes.flatMap((node) => node.childIds.map((childId) => ({ parentId: node.id, childId })))
    .sort((left, right) => left.parentId.localeCompare(right.parentId) || left.childId.localeCompare(right.childId));

  return { roots, nodes, edges, denseParents, disconnectedNodeIds, cycles };
}

function increment(values: Map<string, number>, id: string): void {
  values.set(id, (values.get(id) ?? 0) + 1);
}

function addToSet(values: Map<string, Set<string>>, key: string, value: string): void {
  const set = values.get(key) ?? new Set<string>();
  set.add(value);
  values.set(key, set);
}

function descendantCount(id: string, childrenByParent: ReadonlyMap<string, ReadonlySet<string>>): number {
  const seen = new Set<string>([id]);
  const visit = (nodeId: string): void => {
    for (const childId of childrenByParent.get(nodeId) ?? []) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      visit(childId);
    }
  };
  visit(id);
  return seen.size - 1;
}

function reachableFrom(roots: readonly string[], childrenByParent: ReadonlyMap<string, ReadonlySet<string>>): ReadonlySet<string> {
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const childId of childrenByParent.get(id) ?? []) visit(childId);
  };
  for (const root of roots) visit(root);
  return seen;
}

function detectCycles(
  ids: readonly string[],
  childrenByParent: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const known = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id];
      const key = canonicalCycle(cycle).join("|");
      if (!known.has(key)) {
        known.add(key);
        cycles.push(canonicalCycle(cycle));
      }
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    active.add(id);
    stack.push(id);
    for (const childId of [...(childrenByParent.get(id) ?? new Set<string>())].sort()) visit(childId);
    stack.pop();
    active.delete(id);
  };
  for (const id of ids) visit(id);
  return cycles.sort((left, right) => left.join("|").localeCompare(right.join("|")));
}

function canonicalCycle(cycle: readonly string[]): string[] {
  const unique = cycle.slice(0, -1);
  if (unique.length === 0) return [];
  const rotations = unique.map((_, index) => [...unique.slice(index), ...unique.slice(0, index)]);
  rotations.sort((left, right) => left.join("|").localeCompare(right.join("|")));
  return rotations[0] ?? [];
}

function compareDenseNode(left: HistoricalDetachedChildDossierNode, right: HistoricalDetachedChildDossierNode): number {
  return right.directProposedChildCount - left.directProposedChildCount
    || right.totalFindingCount - left.totalFindingCount
    || left.id.localeCompare(right.id);
}
