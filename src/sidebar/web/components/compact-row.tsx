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
import { useCallback } from "react";
import type { SidebarSessionRow, SidebarSummary } from "../../projection.ts";
import { relativeTime } from "../format.ts";
import { cn } from "@/lib/utils";
import { SuggestionChip } from "./suggestion-chip.tsx";
import { ProjectMark } from "./project-mark.tsx";
import { ArchiveIcon, CheckIcon, CloseIcon, CopyIcon, SummaryIcon } from "./icons.tsx";
import { RowAction } from "./row-action.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { summaryAsText } from "./summary-card.tsx";

export interface CompactRowProps {
  readonly row: SidebarSessionRow;
  readonly now: number;
  readonly selected: boolean;
  readonly opening: boolean;
  readonly onOpen: (row: SidebarSessionRow) => void;
  /**
   * Lifecycle actions, the same ones the full rows offer.
   *
   * A closed session is the one most likely to want completing or archiving -- it is finished work
   * you are looking back at -- so leaving these off the collapsed rows put the actions furthest
   * from where they were most wanted.
   */
  readonly onLifecycle: (
    row: SidebarSessionRow,
    action: "complete" | "archive" | "uncomplete" | "unarchive",
  ) => void;
  /**
   * Refuse enrichment's verdict. Lives in the context menu rather than on the row: it is the
   * rarest of the three things you do with a suggestion, and giving it an icon put a cross beside
   * controls that already read as "no".
   */
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
  onDismiss,
  onLifecycle,
  registerRef,
  onHover,
}: CompactRowProps): React.ReactElement {
  const age = relativeTime(row.lastActivityAt, now);
  const suggestion = row.suggestion;

  const open = useCallback((): void => onOpen(row), [onOpen, row]);

  const rowButton = (
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
      ref={(element) => registerRef?.(row.id, element)}
      type="button"
    >
      <ProjectMark faviconUrl={row.faviconUrl} muted />
      <span className="min-w-0 flex-1 truncate text-[12px] leading-[18px] font-normal text-muted-foreground group-hover:text-foreground">
        {row.name}
      </span>
      {suggestion ? <SuggestionChip suggestion={suggestion} /> : null}
      {/* Lifecycle controls, revealed like the full rows'. A completed row offers only the way
        * back, and an archived one likewise: showing "Archive" beside a completed row invites a
        * second terminal state that says nothing new. */}
      <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
        {row.lifecycle !== "archived" ? (
          <RowAction
            label={row.lifecycle === "completed" ? "Mark not complete" : "Complete"}
            onClick={() => onLifecycle(row, row.lifecycle === "completed" ? "uncomplete" : "complete")}
            tone="confirm"
          >
            <CheckIcon className="size-3" />
          </RowAction>
        ) : null}
        {row.lifecycle !== "completed" ? (
          <RowAction
            label={row.lifecycle === "archived" ? "Unarchive" : "Archive"}
            onClick={() => onLifecycle(row, row.lifecycle === "archived" ? "unarchive" : "archive")}
            tone="shelve"
          >
            <ArchiveIcon className="size-2.5" />
          </RowAction>
        ) : null}
      </span>
      {/* The same trigger the full rows use, so the gesture is one thing to learn. Only on hover:
        * a column of icons down a list of closed sessions would out-shout the sessions. */}
      <span
        aria-label="Show summary"
        className="hidden size-4 shrink-0 cursor-help items-center justify-center rounded-sm
          text-muted-foreground/60 hover:text-foreground group-hover:flex"
        onMouseEnter={(event) => onHover(row, event.currentTarget.closest("button"))}
        onMouseLeave={() => onHover(row, null)}
        title="Show summary"
      >
        <SummaryIcon className="size-3" />
      </span>
      {age ? (
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{age}</span>
      ) : null}
    </button>
  );

  const completed = row.lifecycle === "completed";
  const archived = row.lifecycle === "archived";
  const summary = row.summary;

  // The same menu the full rows carry, so right-click means one thing everywhere in the list. It
  // is also the only home for the actions that do not earn a permanent icon: refusing a verdict,
  // and reading a summary past the card's clamp.
  return (
    <ContextMenu>
      {/* `render` hands Base UI the row itself, so the row stays one element and one tab stop. */}
      <ContextMenuTrigger render={rowButton} />
      <ContextMenuContent>
        {!archived ? (
          <ContextMenuItem onClick={() => onLifecycle(row, completed ? "uncomplete" : "complete")}>
            <CheckIcon />
            {completed ? "Mark not complete" : "Complete"}
          </ContextMenuItem>
        ) : null}
        {!completed ? (
          <ContextMenuItem onClick={() => onLifecycle(row, archived ? "unarchive" : "archive")}>
            <ArchiveIcon />
            {archived ? "Unarchive" : "Archive"}
          </ContextMenuItem>
        ) : null}
        {suggestion && onDismiss ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => onDismiss(row)}>
              <CloseIcon />
              Dismiss “{suggestion.junk ? "junk" : suggestion.verb}”
            </ContextMenuItem>
          </>
        ) : null}
        {summary ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(summaryAsText(summary as SidebarSummary, row.name));
              }}
            >
              <CopyIcon />
              Copy summary
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
