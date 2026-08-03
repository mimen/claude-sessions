/**
 * A group heading with two controls.
 *
 * Shelving is a property of grouping itself, not a feature of one kind of group: "Today", a
 * project, a cluster and "Archived" all get it from here. That is what lets finished work be an
 * ordinary section instead of a pinned bar with its own rules -- a header that can be shelved
 * needs no help staying out of the way.
 *
 * The label shelves; the count filters. They were briefly one three-stop cycle, which forced you
 * through "only what is running" to reach "hidden" and made a single control mean two unrelated
 * things. Two buttons, each binary and each reversible in one click, and the count reads "2 of 10"
 * at all times so the filter needs no separate indicator to be legible.
 */
import type React from "react";
import { cn } from "@/lib/utils";
import type { ShelfState } from "../format.ts";
import { ChevronIcon } from "./icons.tsx";

export interface GroupHeaderProps {
  readonly label: string;
  /** Rows in the group. Shown even while shelved, since it is the reason to unshelve. */
  readonly count: number;
  /** Rows the current state shows. Equal to `count` unless filtered to live. */
  readonly shown: number;
  readonly state: ShelfState;
  /**
   * Whether this group holds both running and finished rows.
   *
   * Passed rather than inferred from the counts: unfiltered they are equal, so a mixed group and a
   * one-kind group look identical from here. Without it the count would offer a click that either
   * changes nothing or empties the group.
   */
  readonly filterable: boolean;
  readonly onToggleShelved: () => void;
  readonly onToggleLiveOnly: () => void;
  /**
   * A colour for the group, when it has one to claim -- a cluster's own. Rendered as a leading
   * bar rather than tinted text, so the label keeps its contrast whatever the hue.
   */
  readonly color?: string | null;
}

const HEADER_TEXT = "text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground";

export function GroupHeader({
  label,
  count,
  shown,
  state,
  filterable,
  onToggleShelved,
  onToggleLiveOnly,
  color,
}: GroupHeaderProps): React.ReactElement {
  // Shelved, the count would read "0 of 10", which says a filter emptied the group when the
  // chevron already says you closed it. The total alone is the honest thing to show.
  const tally = state.shelved ? `${count}` : `${shown} of ${count}`;

  return (
    // A div, not a button: a button inside a button is invalid, and the count has to be its own
    // control rather than a click target smuggled inside the other one.
    <div className={cn("group/header flex w-full items-center gap-1.5 px-0.5 pt-2 pb-1", HEADER_TEXT)}>
      <button
        aria-expanded={!state.shelved}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left hover:text-foreground
          focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onToggleShelved}
        title={state.shelved ? "Show this group" : "Hide this group"}
        type="button"
      >
        {/* Leading, where a disclosure control belongs, and always visible now that it is one of
          * two things in the header rather than the only one. On the right it had to hide itself
          * to avoid a column of arrows; on the left a column of them reads as structure. */}
        <ChevronIcon
          className={cn(
            "size-3 shrink-0 transition-transform opacity-50 group-hover/header:opacity-90",
            state.shelved && "-rotate-90",
          )}
        />
        {color ? (
          <span
            aria-hidden="true"
            className="h-2.5 w-[3px] shrink-0 rounded-full"
            style={{ background: color }}
          />
        ) : null}
        <span className="truncate">{label}</span>
      </button>

      {/* Always "shown of total", so the count is the filter's own readout: there is no state the
        * header can be in that the numbers do not describe. */}
      {filterable ? (
        <button
          aria-pressed={state.liveOnly}
          className={cn(
            "shrink-0 cursor-pointer rounded-(--radius) px-1 font-semibold tabular-nums",
            "hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
            state.liveOnly ? "text-[color:var(--action-confirm)]" : "opacity-70",
          )}
          onClick={onToggleLiveOnly}
          title={state.liveOnly ? "Show all of this group" : "Show only what is running"}
          type="button"
        >
          {tally}
        </button>
      ) : (
        // Nothing to filter, so nothing to click. Same text, no affordance, no dead control.
        <span className="shrink-0 px-1 font-semibold tabular-nums opacity-70">{tally}</span>
      )}
    </div>
  );
}
