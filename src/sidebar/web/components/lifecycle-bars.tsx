/**
 * Complete and archived, as two bars pinned to the bottom of the sidebar.
 *
 * They cannot be sections at the end of the list. The list scrolls without a bottom -- closed
 * sessions page in as you reach them -- so anything placed after it in document order is
 * unreachable by construction, not merely far away. Pinning them means they are one click from any
 * scroll position.
 *
 * The counts are the second reason. They come from the catalogue rather than from the rows on
 * screen, so they state what is NOT in view, and being always visible makes them a standing readout
 * of the backlog rather than something you go and look up.
 */
import type React from "react";
import type { SidebarLifecycle } from "../../projection.ts";
import { cn } from "@/lib/utils";
import { ArchiveIcon, CheckIcon, ChevronIcon } from "./icons.tsx";

export interface LifecycleBarsProps {
  readonly counts: Readonly<Record<SidebarLifecycle, number>>;
  /** Which lifecycle the list is currently showing. */
  readonly scope: SidebarLifecycle;
  readonly onSelect: (scope: SidebarLifecycle) => void;
}

interface BarProps {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onClick: () => void;
  readonly icon: React.ReactNode;
}

function Bar({ label, count, expanded, onClick, icon }: BarProps): React.ReactElement {
  return (
    <button
      aria-expanded={expanded}
      className={cn(
        "flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-left",
        "text-[10px] font-bold uppercase tracking-[0.08em] transition-colors",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        expanded
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <span className="flex size-3 shrink-0 items-center justify-center">{icon}</span>
      <span className="truncate">{label}</span>
      <span className="font-semibold opacity-70">{count}</span>
      {/* Points down when collapsed, up when this bar owns the list -- the chevron says which way
        * clicking will move you, not which state you are in. */}
      <ChevronIcon className={cn("ml-auto size-3 transition-transform", expanded && "rotate-180")} />
    </button>
  );
}

export function LifecycleBars({ counts, scope, onSelect }: LifecycleBarsProps): React.ReactElement {
  return (
    <div className="shrink-0 border-t border-border bg-background">
      <Bar
        count={counts.completed}
        expanded={scope === "completed"}
        icon={<CheckIcon className="size-3" />}
        label="Complete"
        // Clicking an expanded bar returns to the active list, so the bars are a toggle rather
        // than a one-way trip that leaves you hunting for the way back.
        onClick={() => onSelect(scope === "completed" ? "active" : "completed")}
      />
      <Bar
        count={counts.archived}
        expanded={scope === "archived"}
        icon={<ArchiveIcon className="size-2.5" />}
        label="Archived"
        onClick={() => onSelect(scope === "archived" ? "active" : "archived")}
      />
    </div>
  );
}
