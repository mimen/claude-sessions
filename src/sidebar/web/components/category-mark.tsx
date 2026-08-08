import type React from "react";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import { cn } from "@/lib/utils";

/** The category wording exposed beside a decorative mark, or nothing when projection failed. */
export function categoryAccessibleLabel(category: SidebarCategoryProjection | null): string | null {
  if (category === null) return null;
  return category.fullLabel ?? "Uncategorized";
}

/**
 * Registry colour carried unchanged into the UI.
 *
 * Eight pixels leaves enough painted area for neighbouring hues to remain distinct. Uncategorized
 * keeps that footprint as an outline, so it is an intentional state; a missing projection renders
 * nothing because registry failure is not another category.
 */
export function CategoryMark({
  category,
  className,
}: {
  readonly category: SidebarCategoryProjection | null;
  readonly className?: string;
}): React.ReactElement | null {
  if (category === null) return null;
  if (category.effectiveSlug === null) {
    return (
      <span
        aria-hidden="true"
        className={cn("size-2 shrink-0 rounded-full border border-muted-foreground/70", className)}
      />
    );
  }
  if (category.hex === null) return null;
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: category.hex }}
    />
  );
}

/** Screen-reader counterpart to the mark; colour is never the category's only carrier. */
export function CategoryAccessibleText({
  category,
}: {
  readonly category: SidebarCategoryProjection | null;
}): React.ReactElement | null {
  const label = categoryAccessibleLabel(category);
  return label ? <span className="sr-only">Category: {label}.</span> : null;
}
