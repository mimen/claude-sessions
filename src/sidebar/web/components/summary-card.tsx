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
import type { SidebarSummary } from "../../projection.ts";

const RECOMMENDATION_TONES: Readonly<Record<string, string>> = {
  complete: "var(--action-confirm)",
  archive: "var(--action-shelve)",
  handoff: "var(--action-destroy)",
  continue: "#4C8DFF",
};

/** How far the transcript has moved since the enrichment was written. */
export function summaryAge(messagesSince: number | null): string | null {
  if (messagesSince === null) return null;
  if (messagesSince === 0) return "up to date";
  return `${messagesSince} message${messagesSince === 1 ? "" : "s"} since`;
}

/** The whole enrichment record as plain text, for the clipboard. */
export function summaryAsText(summary: SidebarSummary, name: string): string {
  const parts = [name, ""];
  if (summary.recommendation) parts.push(`Recommendation: ${summary.recommendation}`, "");
  parts.push(summary.state);
  if (summary.reason) parts.push("", `Reason: ${summary.reason}`);
  if (summary.next) parts.push("", `Next: ${summary.next}`);
  if (summary.remaining) parts.push("", `Remaining: ${summary.remaining}`);
  if (summary.history) parts.push("", `History: ${summary.history}`);
  return parts.join("\n");
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
    <span className="text-[11px] leading-[1.4] text-muted-foreground">
      No summary yet. Enrichment has not run on this session.
    </span>
  );
}

export function SummaryCard({ summary }: { summary: SidebarSummary }): React.ReactElement {
  const age = summaryAge(summary.messagesSince);
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
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-foreground">
                {summary.junk ? "junk" : summary.recommendation}
              </span>
            </>
          ) : null}
          {age ? (
            <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{age}</span>
          ) : null}
        </span>
      ) : null}
      {/*
        * The card ignores the pointer so it never blocks the row beneath, which also means it can
        * never be scrolled. The body is therefore capped by clamping rather than overflow, and
        * "Copy summary" in the context menu is the way to read anything past the cut.
        */}
      <span className="line-clamp-[10] text-[12px] leading-[1.45] text-foreground">
        {summary.state}
      </span>
      {summary.next ? (
        <span className="border-t border-border pt-2 text-[11px] leading-[1.4] text-foreground">
          <span className="text-muted-foreground">Next </span>
          {summary.next}
        </span>
      ) : null}
      {summary.reason ? (
        <span className="border-t border-border pt-2 text-[11px] leading-[1.4] text-muted-foreground">
          {summary.reason}
        </span>
      ) : null}
    </>
  );
}
