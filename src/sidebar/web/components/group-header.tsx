/**
 * A group heading you can shelve.
 *
 * Shelving is a property of grouping itself, not a feature of one kind of group: "Today", a
 * project, a cluster and "Archived" all get it from here. That is what lets finished work be an
 * ordinary section instead of a pinned bar with its own rules -- a header that can be shelved
 * needs no help staying out of the way.
 *
 * One control, and its stops depend on the group. A group holding both running and finished work
 * gets a middle stop that shows only what is running; a group holding one kind stays the plain
 * open/closed control, because a stop that changes nothing is worse than one that is missing.
 */
import type React from "react";
import { cn } from "@/lib/utils";
import type { ShelfState } from "../format.ts";
import { ChevronIcon } from "./icons.tsx";

export interface GroupHeaderProps {
  readonly label: string;
  /** Rows in the group. Shown even while shelved, since it is the reason to unshelve. */
  readonly count: number;
  /** Rows the current state actually shows. Equal to `count` unless filtered to live. */
  readonly shown: number;
  readonly state: ShelfState;
  /**
   * Whether this group has both running and finished rows, and so has a live-only stop to offer.
   *
   * Passed rather than inferred from the counts: while showing everything they are equal, so a
   * mixed group and a one-kind group look identical from here -- which made the hint promise
   * "Hide" on a group whose next click would filter.
   */
  readonly filterable: boolean;
  readonly onCycle: () => void;
  /**
   * A colour for the group, when it has one to claim -- a cluster's own. Rendered as a leading
   * bar rather than tinted text, so the label keeps its contrast whatever the hue.
   */
  readonly color?: string | null;
}

/** What the control will do next, so the cycle is discoverable before committing to a click. */
function actionHint(state: ShelfState, filterable: boolean): string {
  if (state === "collapsed") return "Show all";
  if (state === "live") return "Hide";
  return filterable ? "Show only what is running" : "Hide";
}

export function GroupHeader({
  label,
  count,
  shown,
  state,
  filterable,
  onCycle,
  color,
}: GroupHeaderProps): React.ReactElement {
  const filtered = state === "live";

  return (
    <button
      aria-expanded={state !== "collapsed"}
      className={cn(
        "group/header flex w-full cursor-pointer items-center gap-1.5 px-0.5 pt-2 pb-1 text-left",
        "text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground",
        "hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
      )}
      onClick={onCycle}
      title={actionHint(state, filterable)}
      type="button"
    >
      {color ? (
        <span
          aria-hidden="true"
          className="h-2.5 w-[3px] shrink-0 rounded-full"
          style={{ background: color }}
        />
      ) : null}
      <span className="truncate">{label}</span>
      {/*
        * A filtered group says what it is hiding. "2" beside a group of nine would be a lie by
        * omission -- the same failure the finished sections had before they started showing their
        * catalogue total while shelved.
        */}
      <span className="shrink-0 font-semibold opacity-70">
        {filtered ? `${shown} of ${count}` : count}
      </span>
      {/* The state has to be readable without clicking, and a count alone cannot carry it: a
        * filtered group and a small group look identical. The dot is cmux's live green. */}
      {filtered ? (
        <span
          aria-label="showing only running sessions"
          className="size-1.5 shrink-0 rounded-full bg-[color:var(--action-confirm)]"
        />
      ) : null}
      {/* Rotates to point at the rows when they are showing. Only on hover or while shelved:
        * a chevron on every expanded header would be a column of arrows down the whole list. */}
      <ChevronIcon
        className={cn(
          "ml-auto size-3 shrink-0 transition-transform",
          state === "collapsed" ? "-rotate-90 opacity-70" : "opacity-0 group-hover/header:opacity-70",
        )}
      />
    </button>
  );
}
