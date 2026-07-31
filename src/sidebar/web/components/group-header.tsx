/**
 * A group heading you can shelve.
 *
 * Collapsing is a property of grouping itself, not a feature of one kind of group: "Today", a
 * project, a cluster and "Archived" all get it from here. That is what lets finished work be an
 * ordinary section instead of a pinned bar with its own rules -- a header that can be shelved
 * needs no help staying out of the way.
 */
import type React from "react";
import { cn } from "@/lib/utils";
import { ChevronIcon } from "./icons.tsx";

export interface GroupHeaderProps {
  readonly label: string;
  /** Rows in the group. Shown even while collapsed, since it is the reason to expand. */
  readonly count: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /**
   * A colour for the group, when it has one to claim -- a cluster's own. Rendered as a leading
   * bar rather than tinted text, so the label keeps its contrast whatever the hue.
   */
  readonly color?: string | null;
}

export function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
  color,
}: GroupHeaderProps): React.ReactElement {
  return (
    <button
      aria-expanded={!collapsed}
      className={cn(
        "group/header flex w-full cursor-pointer items-center gap-1.5 px-0.5 pt-2 pb-1 text-left",
        "text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground",
        "hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
      )}
      onClick={onToggle}
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
      <span className="font-semibold opacity-70">{count}</span>
      {/* Rotates to point at the rows when they are showing. Only on hover or while collapsed:
        * a chevron on every expanded header would be a column of arrows down the whole list. */}
      <ChevronIcon
        className={cn(
          "ml-auto size-3 shrink-0 transition-transform",
          collapsed ? "-rotate-90 opacity-70" : "opacity-0 group-hover/header:opacity-70",
        )}
      />
    </button>
  );
}
