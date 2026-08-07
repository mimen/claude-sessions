import type { CategoryAssignment } from "./assignment.ts";
import { categoryBySlug, slugFromDomainTag, type CategoryRegistry } from "./registry.ts";

export type CategoryStaleReason =
  | "category-missing"
  | "category-invalid"
  | "category-conflict"
  | "category-version-drift"
  | "category-write-failed";

export interface CategoryStalenessVerdict {
  readonly stale: boolean;
  readonly reasons: readonly CategoryStaleReason[];
  readonly needsModelFallback: boolean;
}

export function categoryStaleness(input: {
  readonly assignment: CategoryAssignment | null | undefined;
  readonly tags: readonly string[];
  readonly registry: CategoryRegistry;
}): CategoryStalenessVerdict {
  const parsedTags = input.tags.map(slugFromDomainTag);
  const domainSlugs = parsedTags.filter((slug): slug is string => slug !== null);
  const reasons: CategoryStaleReason[] = [];
  if (!input.assignment || domainSlugs.length === 0) reasons.push("category-missing");
  if (input.tags.length > 1 || (input.assignment && domainSlugs[0] && input.assignment.slug !== domainSlugs[0])) {
    reasons.push("category-conflict");
  }
  if (parsedTags.some((slug) => slug === null) ||
      domainSlugs.some((slug) => !categoryBySlug(input.registry, slug)) ||
      (input.assignment && !categoryBySlug(input.registry, input.assignment.slug))) {
    reasons.push("category-invalid");
  }
  if (input.assignment && input.assignment.classifierVersion !== input.registry.classifierVersion && !input.assignment.manualLock) {
    reasons.push("category-version-drift");
  }
  if (input.assignment?.failedWrite) reasons.push("category-write-failed");
  return {
    stale: reasons.length > 0,
    reasons,
    needsModelFallback: reasons.some((reason) =>
      reason === "category-missing" || reason === "category-conflict" || reason === "category-invalid"),
  };
}
