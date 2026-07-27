/**
 * A closed or settled session, in one line.
 *
 * Closing a session is a memory decision, not a judgment about the work, so a closed row has to
 * stay legible and reopenable while costing almost nothing to scroll past. Colour alone does not
 * achieve that: a muted three-line card is quieter but still eats three lines, so a hundred of them
 * bury the handful that need you. Height is the honest currency, and this row spends about a third
 * of what a live one does.
 *
 * What survives the collapse: the project's own mark, the name, enrichment's verdict when it still
 * contradicts where the session sits, and the age. Age earns its place because it is the field that
 * actually decides whether you would reopen something.
 */
import type React from "react";
import { useCallback, useState } from "react";
import type { SidebarSessionRow } from "../../projection.ts";
import { relativeTime } from "../format.ts";
import { cn } from "@/lib/utils";
import { SuggestionChip } from "./suggestion-chip.tsx";
import { ProjectMark } from "./project-mark.tsx";

export interface CompactRowProps {
  readonly row: SidebarSessionRow;
  readonly now: number;
  readonly selected: boolean;
  readonly opening: boolean;
  readonly onOpen: (row: SidebarSessionRow) => void;
  /** Apply enrichment's verdict. Absent for a row whose verdict is not actionable. */
  readonly onAccept?: (row: SidebarSessionRow, verb: "complete" | "archive") => void;
  readonly onDismiss?: (row: SidebarSessionRow) => void;
  readonly registerRef?: (id: string, element: HTMLElement | null) => void;
  /** Report the pointer entering this row, or leaving it (null); the list owns the card. */
  readonly onHover: (row: SidebarSessionRow, element: HTMLElement | null) => void;
}

export function CompactRow({
  row,
  now,
  selected,
  opening,
  onOpen,
  onAccept,
  onDismiss,
  registerRef,
  onHover,
}: CompactRowProps): React.ReactElement {
  const [hovered, setHovered] = useState(false);
  const age = relativeTime(row.lastActivityAt, now);
  const suggestion = row.suggestion;

  const open = useCallback((): void => onOpen(row), [onOpen, row]);

  return (
    <button
      aria-busy={opening}
      aria-selected={selected}
      className={cn(
        // Same horizontal padding, corner radius and bottom margin as the full card, so the hover
        // surface lines up with the cards above instead of reading as a differently-shaped list.
        // Only the vertical padding shrinks -- that is where the height saving comes from.
        "group mb-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-[3px]",
        "text-left transition-colors duration-75",
        "hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        selected && "bg-secondary ring-1 ring-ring/60 ring-inset",
        opening && "cursor-progress opacity-70",
        // Settled work is quieter still than merely closed work: it is finished, and the eye
        // should be able to skip the whole section without reading it.
        row.density === "settled" && "opacity-60",
      )}
      onClick={open}
      onMouseEnter={(event) => { setHovered(true); onHover(row, event.currentTarget); }}
      onMouseLeave={() => { setHovered(false); onHover(row, null); }}
      ref={(element) => registerRef?.(row.id, element)}
      type="button"
    >
      <ProjectMark faviconUrl={row.faviconUrl} muted />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-[18px] font-normal text-muted-foreground group-hover:text-foreground">
        {row.name}
      </span>
      {suggestion ? (
        <SuggestionChip
          onAccept={
            suggestion.actionable && onAccept
              ? () => onAccept(row, suggestion.verb as "complete" | "archive")
              : undefined
          }
          onDismiss={onDismiss ? () => onDismiss(row) : undefined}
          // Buttons only once the row is under the pointer: a list of closed sessions should read
          // as text, not as a wall of controls competing with the live rows above it.
          revealed={hovered}
          suggestion={suggestion}
        />
      ) : null}
      {age ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{age}</span>
      ) : null}
    </button>
  );

}
