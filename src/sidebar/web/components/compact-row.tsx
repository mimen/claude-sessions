/** A closed or settled session compressed to one fixed-height line. */
import type React from "react";
import { useCallback } from "react";
import type { SidebarSessionRow, SidebarSummary } from "../../projection.ts";
import { relativeTime } from "../format.ts";
import { cn } from "@/lib/utils";
import { SuggestionChip } from "./suggestion-chip.tsx";
import { ProjectMark } from "./project-mark.tsx";
import { ArchiveIcon, CheckIcon, CloseIcon, CopyIcon } from "./icons.tsx";
import { RowAction } from "./row-action.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { summaryAsText } from "./summary-card.tsx";
import { CategoryAccessibleText, CategoryMark } from "./category-mark.tsx";
import { FullSummarySubmenu } from "./full-summary.tsx";

export interface CompactRowProps {
  readonly row: SidebarSessionRow;
  readonly now: number;
  readonly selected: boolean;
  readonly opening: boolean;
  readonly onOpen: (row: SidebarSessionRow) => void;
  readonly onLifecycle: (
    row: SidebarSessionRow,
    action: "complete" | "archive" | "uncomplete" | "unarchive",
  ) => void;
  readonly onDismiss?: (row: SidebarSessionRow) => void;
  readonly registerRef?: (id: string, element: HTMLElement | null) => void;
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
  const junk = row.summary?.junk === true;
  const open = useCallback((): void => onOpen(row), [onOpen, row]);

  const rowButton = (
    <button
      aria-busy={opening}
      aria-selected={selected}
      className={cn(
        // Compact rows still have one invariant height. Their name never wraps, and the hover
        // controls overlay the reserved age slot instead of replacing it in layout.
        "group relative mb-1.5 flex h-7 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md px-2.5",
        "text-left transition-colors duration-75",
        "hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        selected && "bg-secondary ring-1 ring-ring/60 ring-inset",
        opening && "cursor-progress opacity-70",
        // Settled rows can be quieter, but junk uses neutral colour at full contrast. Combining the
        // two opacity treatments made exactly the rows needing review hardest to read.
        !junk && row.density === "settled" && "opacity-60",
        junk && "text-neutral-400",
      )}
      data-junk={junk ? "true" : undefined}
      onClick={open}
      ref={(element) => registerRef?.(row.id, element)}
      type="button"
    >
      <span className={cn("flex shrink-0 items-center", junk && "grayscale")}>
        <CategoryMark category={row.category} className="mr-0.5" />
        <CategoryAccessibleText category={row.category} />
      </span>
      <ProjectMark faviconUrl={row.faviconUrl} muted />
      <span className={cn(
        "min-w-0 flex-1 truncate text-[12px] leading-[18px] font-normal text-muted-foreground group-hover:text-foreground",
        junk && "text-neutral-300 group-hover:text-neutral-200",
      )}>
        {row.name}
      </span>
      {suggestion ? (
        <span className={cn("shrink-0", junk && "grayscale")}>
          <SuggestionChip suggestion={suggestion} />
        </span>
      ) : null}

      {/* Sized to the age it actually holds. The old fixed slot reserved 76px for text like "15h"
        and left 55px empty on every row while the name beside it was truncated. Hover actions are
        absolutely positioned and overhang leftward, so nothing here shifts on hover. */}
      <span className="relative flex h-5 shrink-0 items-center justify-end">
        {age ? (
          <span className={cn(
            "text-[10px] tabular-nums text-muted-foreground/70",
            junk && "text-neutral-400",
          )}>{age}</span>
        ) : null}
        <span
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 flex w-[76px] items-center justify-end gap-1 pl-4 opacity-0",
            "bg-gradient-to-l from-secondary via-secondary/95 to-transparent transition-opacity duration-75",
            "group-hover:opacity-100 [&>[role=button]]:pointer-events-auto",
          )}
          data-row-actions-overlay="true"
        >
          {row.lifecycle !== "archived" ? (
            <RowAction
              label={row.lifecycle === "completed" ? "Mark not complete" : "Complete"}
              onClick={() => onLifecycle(row, row.lifecycle === "completed" ? "uncomplete" : "complete")}
              onHover={(anchor) => onHover(row, anchor)}
              tone="confirm"
            >
              <CheckIcon className="size-3" />
            </RowAction>
          ) : null}
          {row.lifecycle !== "completed" ? (
            <RowAction
              label={row.lifecycle === "archived" ? "Unarchive" : "Archive"}
              onClick={() => onLifecycle(row, row.lifecycle === "archived" ? "unarchive" : "archive")}
              onHover={(anchor) => onHover(row, anchor)}
              tone="shelve"
            >
              <ArchiveIcon className="size-2.5" />
            </RowAction>
          ) : null}
        </span>
      </span>
    </button>
  );

  const completed = row.lifecycle === "completed";
  const archived = row.lifecycle === "archived";
  const summary = row.summary;

  return (
    <ContextMenu>
      <ContextMenuTrigger render={rowButton} />
      <ContextMenuContent>
        {suggestion && onDismiss ? (
          <>
            <ContextMenuGroup>
              <ContextMenuLabel>{suggestion.verb} suggested</ContextMenuLabel>
              {suggestion.reason ? (
                <div className="max-w-64 px-2 pb-1.5 text-[11px] leading-[1.4] text-muted-foreground">
                  {suggestion.reason}
                </div>
              ) : null}
              {suggestion.actionable ? (
                <ContextMenuItem onClick={() => onLifecycle(row, suggestion.verb as "complete" | "archive")}>
                  {suggestion.verb === "archive" ? <ArchiveIcon /> : <CheckIcon />}
                  Accept: {suggestion.verb === "archive" ? "Archive" : "Complete"}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem onClick={() => onDismiss(row)}>
                <CloseIcon />
                Dismiss verdict
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
          </>
        ) : null}

        <ContextMenuGroup>
          <ContextMenuLabel>Lifecycle</ContextMenuLabel>
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
        </ContextMenuGroup>

        {summary ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuLabel>Session</ContextMenuLabel>
              <FullSummarySubmenu category={row.category} summary={summary} />
              <ContextMenuItem
                onClick={() => {
                  void navigator.clipboard.writeText(summaryAsText(summary as SidebarSummary, row.name));
                }}
              >
                <CopyIcon />
                Copy summary
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
