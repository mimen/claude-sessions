import type React from "react";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import type { SidebarSummary } from "../../projection.ts";
import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { CategorySummary } from "./summary-card.tsx";

function SummaryField({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}): React.ReactElement {
  return (
    <div className="grid gap-0.5 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <dt className="text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="m-0 whitespace-pre-wrap text-[11px] leading-[1.45] text-foreground">
        {value || "Not recorded"}
      </dd>
    </div>
  );
}

/**
 * The unabridged enrichment record.
 *
 * The hover card remains deliberately compact and non-interactive. This submenu is the explicit
 * path to every field, including staleness. It never invents a reassuring "current" label: a live
 * transcript can move while its index row does not, so silence is the only honest zero-drift state.
 */
export function FullSummary({
  category,
  summary,
}: {
  readonly category: SidebarCategoryProjection | null;
  readonly summary: SidebarSummary;
}): React.ReactElement {
  return (
    <div className="grid gap-2" data-full-summary="true">
      <CategorySummary category={category} error={null} />
      <dl className="m-0 grid gap-2">
        <SummaryField label="Recommendation" value={summary.recommendation} />
        <SummaryField label="Reason" value={summary.reason} />
        {summary.driftLabel ? <SummaryField label="Staleness" value={summary.driftLabel} /> : null}
        <SummaryField label="State" value={summary.state} />
        <SummaryField label="Next" value={summary.next} />
        <SummaryField label="Remaining" value={summary.remaining} />
        <SummaryField label="History" value={summary.history} />
      </dl>
    </div>
  );
}

export function FullSummarySubmenu({
  category,
  summary,
}: {
  readonly category: SidebarCategoryProjection | null;
  readonly summary: SidebarSummary;
}): React.ReactElement {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>Full summary</ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <FullSummary category={category} summary={summary} />
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
