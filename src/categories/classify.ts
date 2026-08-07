import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import type { LocationRegistry } from "../locations/registry.ts";
import { getCategoryAssignment, type CategorySource } from "./assignment.ts";
import { categoryBySlug, type CategoryRegistry } from "./registry.ts";

export interface CategoryEvidence {
  readonly slug: string;
  readonly source: CategorySource;
  readonly confidence: number;
  readonly evidence: string;
}
export type CategoryClassification =
  | { readonly status: "resolved"; readonly value: CategoryEvidence }
  | { readonly status: "unresolved"; readonly reason: "no-evidence" | "ambiguous" | "invalid-location-category" };

function pathContains(parent: string, child: string): boolean {
  const prefix = resolve(parent).replace(/\/$/, "") + "/";
  const target = resolve(child);
  return target === prefix.slice(0, -1) || target.startsWith(prefix);
}

/** Deterministic evidence only. A caller may request model fallback for unresolved/conflicting roots. */
export function classifyCategory(input: {
  readonly registry: CategoryRegistry;
  readonly locations?: LocationRegistry | null;
  readonly locationKey?: string | null;
  readonly project?: string | null;
  readonly cwd?: string | null;
  readonly parentSessionId?: string | null;
  readonly catalogue?: Database;
}): CategoryClassification {
  const evidence: CategoryEvidence[] = [];
  const location = input.locations?.locations.find((candidate) => candidate.key === input.locationKey);
  if (location?.categoryAmbiguous) return { status: "unresolved", reason: "ambiguous" };
  if (location?.category) {
    if (!categoryBySlug(input.registry, location.category)) {
      return { status: "unresolved", reason: "invalid-location-category" };
    }
    evidence.push({ slug: location.category, source: "location", confidence: 1, evidence: `location:${location.key}` });
  }
  const projectSlug = input.project ? input.registry.projectMappings[input.project] : undefined;
  if (projectSlug) evidence.push({ slug: projectSlug, source: "project", confidence: 0.95, evidence: `project:${input.project}` });
  if (input.cwd) {
    const matches = Object.entries(input.registry.pathMappings)
      .filter(([path]) => pathContains(path, input.cwd!))
      .sort(([left], [right]) => right.length - left.length);
    if (matches[0]) evidence.push({ slug: matches[0][1], source: "path", confidence: 0.9, evidence: `path:${matches[0][0]}` });
  }
  if (input.parentSessionId && input.catalogue) {
    const parent = getCategoryAssignment(input.catalogue, input.parentSessionId);
    if (parent) evidence.push({ slug: parent.slug, source: "parent", confidence: 0.85, evidence: `parent:${input.parentSessionId}` });
  }
  if (evidence.length === 0) return { status: "unresolved", reason: "no-evidence" };
  const winner = evidence[0]!;
  if (evidence.some((candidate) => candidate.slug !== winner.slug)) return { status: "unresolved", reason: "ambiguous" };
  return { status: "resolved", value: winner };
}
