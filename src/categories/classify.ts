import { resolve } from "node:path";
import { expandHome } from "../paths.ts";
import type { Database } from "bun:sqlite";
import type { LocationRegistry, LaunchLocation } from "../locations/registry.ts";
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
  const prefix = resolve(expandHome(parent)).replace(/\/$/, "") + "/";
  const target = resolve(expandHome(child));
  return target === prefix.slice(0, -1) || target.startsWith(prefix);
}

function locationEvidence(
  registry: CategoryRegistry,
  locations: LocationRegistry | null | undefined,
  locationKey: string | null | undefined,
  cwd: string | null | undefined,
): CategoryClassification | null {
  if (!locations) return null;
  let candidates: readonly LaunchLocation[];
  if (locationKey) {
    const exact = locations.locations.find((candidate) => candidate.key === locationKey);
    candidates = exact ? [exact] : [];
  } else if (cwd) {
    candidates = locations.locations
      .filter((candidate) => candidate.status === "active" && pathContains(candidate.cwd, cwd))
      .sort((left, right) => resolve(expandHome(right.cwd)).length - resolve(expandHome(left.cwd)).length);
  } else {
    candidates = [];
  }
  for (const location of candidates) {
    if (location.categoryNeutral) return null;
    if (location.categoryAmbiguous) return { status: "unresolved", reason: "ambiguous" };
    if (!location.category) continue;
    if (!categoryBySlug(registry, location.category)) {
      return { status: "unresolved", reason: "invalid-location-category" };
    }
    return {
      status: "resolved",
      value: {
        slug: location.category,
        source: "location",
        confidence: 1,
        evidence: `location:${location.key}`,
      },
    };
  }
  return null;
}

/** Deterministic precedence: explicit override, registered location, workspace root, then parent. */
export function classifyCategory(input: {
  readonly registry: CategoryRegistry;
  readonly explicitSlug?: string | null;
  readonly locations?: LocationRegistry | null;
  readonly locationKey?: string | null;
  readonly cwd?: string | null;
  readonly parentSessionId?: string | null;
  readonly catalogue?: Database;
}): CategoryClassification {
  if (input.explicitSlug) {
    if (!categoryBySlug(input.registry, input.explicitSlug)) {
      return { status: "unresolved", reason: "invalid-location-category" };
    }
    return {
      status: "resolved",
      value: { slug: input.explicitSlug, source: "manual", confidence: 1, evidence: "explicit-birth-override" },
    };
  }

  const fromLocation = locationEvidence(
    input.registry,
    input.locations,
    input.locationKey,
    input.cwd,
  );
  if (fromLocation) return fromLocation;

  if (input.cwd) {
    const workspace = input.registry.categories
      .filter((category) => pathContains(category.workspacePath, input.cwd!))
      .sort((left, right) => right.workspacePath.length - left.workspacePath.length)[0];
    if (workspace) {
      return {
        status: "resolved",
        value: {
          slug: workspace.slug,
          source: "path",
          confidence: 1,
          evidence: `workspaceRoot:${workspace.workspaceRoot}`,
        },
      };
    }
  }

  if (input.parentSessionId && input.catalogue) {
    const parent = getCategoryAssignment(input.catalogue, input.parentSessionId);
    if (parent) {
      return {
        status: "resolved",
        value: { slug: parent.slug, source: "parent", confidence: 0.9, evidence: `parent:${input.parentSessionId}` },
      };
    }
  }
  return { status: "unresolved", reason: "no-evidence" };
}
