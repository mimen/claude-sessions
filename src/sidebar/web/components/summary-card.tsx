/**
 * What enrichment concluded, shown on hover.
 *
 * Shared by the full and compact rows: a closed session is exactly the case where you have no
 * memory of what it was, so withholding the summary from the collapsed rows would take it away
 * precisely where it is worth most.
 *
 * v40's shape drives the layout. `state` is where the session stands and is the only field
 * guaranteed to exist, so it leads. `next` is one imperative action, promoted out of the old prose
 * blob so it could be read on its own, so it gets its own line. `reason` is conditional: required
 * for archive and handoff, required empty for continue and complete, where it only restated the
 * verdict.
 */
import type React from "react";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import type { SidebarSummary } from "../../projection.ts";
import { CategoryMark, categoryAccessibleLabel } from "./category-mark.tsx";

const RECOMMENDATION_TONES: Readonly<Record<string, string>> = {
  complete: "var(--action-confirm)",
  archive: "var(--action-shelve)",
  handoff: "var(--action-destroy)",
  continue: "#4C8DFF",
};

/**
 * How out of date the enrichment is, in the card's own words.
 *
 * The projection does the judging, because only it can see the filesystem. This deliberately never
 * says "up to date": `messagesSince === 0` means the index has not moved, which is not the same as
 * nothing having happened, and a live session's index row does not move at all. Claiming currency
 * on exactly the sessions most likely to have drifted is the failure this replaced -- observed
 * live, a session indexed at 154 messages whose transcript held 227 was labelled "up to date".
 *
 * Silence is the honest answer when there is nothing to warn about.
 */
export function summaryAge(driftLabel: string | null): string | null {
  return driftLabel;
}

/** The whole enrichment record as plain text, for the clipboard. */
export function summaryAsText(summary: SidebarSummary, name: string): string {
  const parts = [name, ""];
  if (summary.recommendation) parts.push(`Recommendation: ${summary.recommendation}`, "");
  parts.push(summary.state ?? "");
  if (summary.reason) parts.push("", `Reason: ${summary.reason}`);
  if (summary.next) parts.push("", `Next: ${summary.next}`);
  if (summary.remaining) parts.push("", `Remaining: ${summary.remaining}`);
  if (summary.history) parts.push("", `History: ${summary.history}`);
  return parts.join("\n");
}

/** Category context shared by cards with and without enrichment prose. */
export function CategorySummary({
  category,
  error,
}: {
  readonly category: SidebarCategoryProjection | null;
  readonly error: string | null;
}): React.ReactElement {
  if (category === null) {
    return (
      <span className="text-[10px] leading-[1.35] text-[color:var(--action-destroy)]">
        Category unavailable{error ? `: ${error}` : "."}
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5 text-[10px] leading-[1.35] text-muted-foreground">
      <CategoryMark category={category} className="mt-[3px]" />
      <span>
        <span className="text-foreground">Category </span>
        {categoryAccessibleLabel(category)}
      </span>
    </span>
  );
}

/**
 * What to show when a session has never been enriched.
 *
 * Roughly four fifths of sessions are in this state, and silently showing no card at all made it
 * ambiguous: you could not tell a session with nothing to say from one whose card simply failed to
 * appear. Saying so explicitly costs one line and removes the doubt.
 */
export function EmptySummaryCard(): React.ReactElement {
  return (
    <span className="text-[10px] leading-[1.35] text-muted-foreground">
      No summary yet. Enrichment has not run on this session.
    </span>
  );
}

export function SummaryCard({ summary }: { summary: SidebarSummary }): React.ReactElement {
  const age = summaryAge(summary.driftLabel);
  return (
    <>
      {summary.recommendation || age ? (
        <span className="flex items-center gap-1.5">
          {summary.recommendation ? (
            <>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full"
                style={{
                  background: RECOMMENDATION_TONES[summary.recommendation] ?? "var(--muted-foreground)",
                }}
              />
              <span className="text-[9px] font-semibold uppercase tracking-[0.08em] text-foreground">
                {summary.junk ? "junk" : summary.recommendation}
              </span>
            </>
          ) : null}
          {age ? (
            <span className="ml-auto text-[9px] text-[color:var(--action-shelve)]">{age}</span>
          ) : null}
        </span>
      ) : null}
      {/*
        * The card ignores the pointer so it never blocks the row beneath, which also means it can
        * never be scrolled. The body is therefore capped by clamping rather than overflow, and
        * "Copy summary" in the context menu is the way to read anything past the cut.
        */}
      <span className="line-clamp-6 text-[11px] leading-[1.4] text-foreground">
        {summary.state}
      </span>
      {summary.next ? (
        <span className="border-t border-border pt-1.5 text-[10px] leading-[1.35] text-foreground">
          <span className="text-muted-foreground">Next </span>
          {summary.next}
        </span>
      ) : null}
      {summary.reason ? (
        <span className="border-t border-border pt-1.5 text-[10px] leading-[1.35] text-muted-foreground">
          {summary.reason}
        </span>
      ) : null}
    </>
  );
}
