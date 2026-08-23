import type React from "react";
import { useCallback, useEffect, useState } from "react";
import type { CmuxStatusAvailability, SidebarRow, SidebarSessionRow, SidebarSummary } from "../../projection.ts";
import { relativeTime, shortenPath, type RowLayouts } from "../format.ts";
import { cn } from "@/lib/utils";
import {
  BookmarkIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  MaskIcon,
  PinIcon,
  PinOffIcon,
  TrashIcon,
} from "./icons.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusIcon } from "./status-icon.tsx";
import { RowAction } from "./row-action.tsx";
import { summaryAsText } from "./summary-card.tsx";
import { CategoryAccessibleText, CategoryMark } from "./category-mark.tsx";
import { ProjectMark } from "./project-mark.tsx";
import { SuggestionChip } from "./suggestion-chip.tsx";
import { FullSummarySubmenu } from "./full-summary.tsx";

function surfaceSummary(kinds: readonly string[]): string {
  const distinct = [...new Set(kinds)];
  return distinct.length > 0 ? distinct.join(" · ") : "empty";
}

export function StatusMetadata({
  availability,
  status,
}: {
  readonly availability: CmuxStatusAvailability;
  readonly status: SidebarRow["status"];
}): React.ReactElement | null {
  if (status) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate">{status.label}</span>
        <StatusIcon color={status.color} icon={status.icon} />
      </span>
    );
  }
  if (availability === "unreadable") {
    return (
      <span className="flex min-w-0 items-center gap-1 text-[color:var(--action-shelve)]">
        <span className="truncate">Status unavailable</span>
        <StatusIcon
          className="text-[color:var(--action-shelve)]"
          color={null}
          icon={null}
        />
      </span>
    );
  }
  if (availability === "absent") {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span>Live</span>
        <StatusIcon color={null} icon={null} />
      </span>
    );
  }
  // A not-live row has no status to report. Writing "not running" on almost every historical row
  // repeated what the missing glyph and old timestamp already said, so absence is intentional.
  return null;
}

export interface SessionRowProps {
  readonly onLifecycle: (row: SidebarSessionRow, action: "complete" | "save" | "uncomplete" | "unsave") => void;
  readonly onDismiss: (row: SidebarSessionRow) => void;
  readonly onClose: (row: SidebarRow) => void;
  readonly onPin: (row: SidebarRow, pinned: boolean) => void;
  readonly onIncognito: (row: SidebarSessionRow, incognito: boolean) => void;
  /** Opens the confirmation. Nothing is destroyed until that dialog is answered. */
  readonly onDestroy: (row: SidebarSessionRow) => void;
  readonly row: SidebarRow;
  readonly now: number;
  readonly selected: boolean;
  readonly showShortcut: boolean;
  readonly opening: boolean;
  readonly onOpen: (row: SidebarRow) => void;
  readonly registerRef: (element: HTMLButtonElement | null) => void;
  readonly onHover: (row: SidebarRow, element: HTMLElement | null) => void;
  readonly layouts: RowLayouts;
}

export function SessionRow({
  row,
  now,
  selected,
  showShortcut,
  opening,
  onOpen,
  onLifecycle,
  onDismiss,
  onClose,
  onPin,
  onIncognito,
  onDestroy,
  registerRef,
  onHover,
  layouts,
}: SessionRowProps): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeNow = useCallback((): void => onHover(row, null), [onHover, row]);

  /**
   * Dismiss the menu when the pointer or focus leaves the sidebar.
   *
   * Base UI dismisses on an outside press, which is the whole story for a page that owns the
   * screen. This page is a dock panel a few hundred pixels wide: the usual way to abandon a menu
   * here is to move to the terminal beside it, and that produces no press inside the document at
   * all. The menu stayed open over a sidebar nobody was pointing at, and was still there on the
   * next glance.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (): void => setMenuOpen(false);
    window.addEventListener("blur", dismiss);
    document.addEventListener("mouseleave", dismiss);
    return () => {
      window.removeEventListener("blur", dismiss);
      document.removeEventListener("mouseleave", dismiss);
    };
  }, [menuOpen]);
  const session = row.kind === "session" ? row : null;
  const workspace = row.kind === "workspace" ? row : null;
  const saved = session?.lifecycle === "saved";
  const completed = session?.lifecycle === "completed";
  // Read off the section rather than a flag of its own: the projection already decided which rows
  // are marked, and a second source here could show "Leave incognito" on a row that is not.
  const incognito = row.section === "incognito";
  const suggestion = session?.suggestion ?? null;
  const junk = session?.summary?.junk === true;
  const pinnable = row.workspaceId !== null;
  const age = session ? relativeTime(row.lastActivityAt, now) : null;
  // A closed session keeps the live layout and loses only the facts that stopped being true.
  // Model and status describe a running process; on a closed row they are stale, so the row shows
  // what still holds — name, project, category, age — and drops its card so the live rows above it
  // are the only ones carrying weight.
  const ghost = row.kind === "session" && row.density !== "full";
  // Open and closed rows carry different facts, so each side picks its own arrangement.
  const layout = ghost ? layouts.closed : layouts.open;
  const threeLine = layout === "three-line";

  const titleLine = (
      <span
        className={cn(
          // Titles sit a step below the usual UI weights: 500 for rows wanting attention,
          // 400 for the rest. Semibold at 13px read as heavy in a dense list, and the row
          // still marks itself without it — the coloured left edge, the section header, and
          // the status text all say the same thing. One step of weight between the two is
          // enough to keep needs-you rows separable at a glance.
          "truncate text-[13px] leading-[18px]",
          row.section === "needs-you" ? "font-medium" : "font-normal",
          !junk && (ghost || row.section === "recent") && "text-muted-foreground",
          ghost && "group-hover:text-foreground",
          junk && "text-neutral-300",
        )}
        title={row.name}
      >
        {row.name}
      </span>
  );

  const metaItems = (
    <>
      {/* Project first: it is the fact most rows are scanned by, and putting it at the line's
        start keeps every project name on one left edge under the title. Its glyph is muted on
        ghost rows in step with the rest of the row. */}
      <ProjectMark faviconUrl={row.faviconUrl} muted={ghost} />
      <span className="truncate">{row.directory ?? shortenPath(row.directoryPath)}</span>
      {session?.category ? (
        // The dot carries the category's colour and the name carries the category, so the
        // hue is recognition rather than the only encoding. The short label is used because
        // the full one ("Events, Booking & Live Production") would take the line on its own.
        <>
          <span aria-hidden="true">·</span>
          <span className={cn("flex shrink-0 items-center gap-1", junk && "grayscale")}>
            <CategoryMark category={session.category} />
            {session.category.compactLabel ? (
              <span className="shrink-0">{session.category.compactLabel}</span>
            ) : null}
            <CategoryAccessibleText category={session.category} />
          </span>
        </>
      ) : null}
      {session?.t3Associated ? (
        <>
          <span aria-hidden="true">·</span>
          <span
            className="shrink-0 rounded-[3px] border border-border px-1 font-medium text-[8px] leading-[12px]"
            title="Associated with T3 Code"
          >
            T3
          </span>
        </>
      ) : null}
      {session?.model && !ghost ? (
        <>
          <span aria-hidden="true">·</span>
          {/* No vendor logo. The label already names the model and is tinted by vendor, so a
            glyph made it the third encoding of one fact and the loudest thing in the row. */}
          <span
            className={cn("shrink-0", junk && "text-neutral-400")}
            style={junk ? undefined : { color: session.model.color }}
          >
            {session.model.label}
          </span>
        </>
      ) : workspace ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{surfaceSummary(workspace.surfaceKinds)}</span>
        </>
      ) : null}
      {suggestion ? (
        <>
          <span aria-hidden="true">·</span>
          <span className={cn("shrink-0", junk && "grayscale")}>
            <SuggestionChip suggestion={suggestion} />
          </span>
        </>
      ) : null}
    </>
  );

  const metaLine = (
    <span className={cn(
      "flex min-w-0 items-center gap-1 text-[10px] leading-[14px] text-muted-foreground",
      junk && "text-neutral-400",
    )}>
      {metaItems}
    </span>
  );

  const statusLine = (
    <span className={cn(
      "flex min-w-0 items-center justify-end gap-1.5 text-[10px] text-muted-foreground",
      junk && "text-neutral-400",
    )}>
      {row.pinned && row.shortcut !== null && showShortcut ? (
        <span className="shrink-0 rounded-(--radius) border border-border px-1 font-mono text-[9px] leading-[14px]">
          ⌘{row.shortcut}
        </span>
      ) : null}
      {session && !ghost ? <StatusMetadata availability={row.statusAvailability} status={row.status} /> : null}
      {age ? <span className="shrink-0 tabular-nums">{age}</span> : null}
    </span>
  );

  const actionsOverlay = (
    <span
      className={cn(
        "pointer-events-none absolute inset-y-0 right-0 flex w-[132px] items-center justify-end gap-1 pl-5 opacity-0",
        "bg-gradient-to-l from-secondary via-secondary/95 to-transparent transition-opacity duration-75",
        "group-hover:opacity-100 [&>[role=button]]:pointer-events-auto",
      )}
      data-row-actions-overlay="true"
    >
      {workspace ? (
        <RowAction label="Close tab" onClick={() => onClose(workspace)} tone="destroy">
          <CloseIcon className="size-3" />
        </RowAction>
      ) : null}
      {session && !completed ? (
        <RowAction
          label={saved ? "Move to Active" : "Save for later"}
          onClick={() => onLifecycle(session, saved ? "unsave" : "save")}
          onHover={(anchor) => onHover(row, anchor)}
          tone="shelve"
        >
          <BookmarkIcon className="size-2.5" />
        </RowAction>
      ) : null}
      {session && !completed ? (
        <RowAction
          label="Mark done"
          onClick={() => onLifecycle(session, "complete")}
          onHover={(anchor) => onHover(row, anchor)}
          tone="confirm"
        >
          <CheckIcon className="size-3" />
        </RowAction>
      ) : null}
      {/* Only when there is a tab to close. Rendering it disabled everywhere put a dead control on
        every closed row — 393 of 398 on the live list — to keep the icons in fixed positions. The
        overlay is absolutely positioned against the row's right edge, so dropping a button shifts
        the rest along that edge and cannot reflow the row, which was the invariant worth having. */}
      {session && row.workspaceRef ? (
        <RowAction
          label="Close tab"
          onClick={() => onClose(session)}
          onHover={(anchor) => onHover(row, anchor)}
          tone="dismiss"
        >
          <CloseIcon className="size-3" />
        </RowAction>
      ) : null}
    </span>
  );

  const rowButton = (
    <button
      aria-busy={opening}
      aria-selected={selected}
      className={cn(
        // Every row owns exactly 46px. Long names truncate instead of buying a second line, so live
        // data cannot turn the list into a mixture of heights and move targets under the pointer.
        "group relative mb-1.5 block w-full cursor-pointer overflow-hidden rounded-md px-2.5 text-left",
        threeLine ? "h-[62px]" : "h-[46px]",
        "transition-colors duration-75",
        ghost ? "bg-transparent" : "bg-card",
        "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-transparent",
        "hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        row.focused && "bg-secondary before:bg-primary",
        // Unread uses cmux blue on the shared edge. Focus wins when both apply: location is the fact
        // needed first, and opening the focused row is about to clear the unread state anyway. The
        // count remains sr-only; a badge previously pushed the title and made the news row reflow.
        !row.focused && row.unread > 0 && "before:bg-[#4C8DFF]",
        selected && !row.focused && "ring-1 ring-ring/60 ring-inset",
        opening && "cursor-progress opacity-70",
        // Junk loses colour, never contrast. Applying neutral text instead of opacity also prevents
        // the existing recent/settled muting from stacking into illegibility.
        junk && "text-neutral-400",
      )}
      data-junk={junk ? "true" : undefined}
      data-row-id={row.id}
      data-section={row.section}
      onClick={() => { if (!opening) onOpen(row); }}
      ref={registerRef}
      type="button"
    >
      {layout === "compact" ? (
        <span className="flex h-full min-w-0 items-center gap-2">
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span className="flex min-w-0 items-center">
              {row.unread > 0 ? <span className="sr-only">{row.unread} unread</span> : null}
              {titleLine}
            </span>
            {metaLine}
          </span>
          <span className="relative flex h-full shrink-0 items-center justify-end">
            {statusLine}
            {actionsOverlay}
          </span>
        </span>
      ) : threeLine ? (
        <span className="relative flex h-full min-w-0 flex-col justify-center gap-[1px]">
          {row.unread > 0 ? <span className="sr-only">{row.unread} unread</span> : null}
          <span className="flex min-w-0 items-center gap-1 text-[10px] leading-[14px] text-muted-foreground">
            <ProjectMark faviconUrl={row.faviconUrl} muted={ghost} />
            <span className="truncate">{row.directory ?? shortenPath(row.directoryPath)}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{statusLine}</span>
          </span>
          {titleLine}
          <span className="flex min-w-0 items-center gap-1 text-[10px] leading-[14px] text-muted-foreground">
            {session?.category ? (
              <span className={cn("flex shrink-0 items-center gap-1", junk && "grayscale")}>
                <CategoryMark category={session.category} />
                {session.category.compactLabel ? (
                  <span className="shrink-0">{session.category.compactLabel}</span>
                ) : null}
                <CategoryAccessibleText category={session.category} />
              </span>
            ) : null}
            {session?.model && !ghost ? (
              <>
                <span aria-hidden="true">·</span>
                <span className={cn("shrink-0", junk && "text-neutral-400")} style={junk ? undefined : { color: session.model.color }}>
                  {session.model.label}
                </span>
              </>
            ) : null}
            {suggestion ? (
              <>
                <span aria-hidden="true">·</span>
                <span className={cn("shrink-0", junk && "grayscale")}><SuggestionChip suggestion={suggestion} /></span>
              </>
            ) : null}
          </span>
          {actionsOverlay}
        </span>
      ) : (
        <span className="relative flex h-full min-w-0 flex-col justify-center gap-[2px]">
          {row.unread > 0 ? <span className="sr-only">{row.unread} unread</span> : null}
          {titleLine}
          <span className="flex min-w-0 items-center gap-1 text-[10px] leading-[14px] text-muted-foreground">
            {metaItems}
            <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">{statusLine}</span>
          </span>
          {actionsOverlay}
        </span>
      )}
    </button>
  );

  return (
    <ContextMenu
      onOpenChange={(next) => { setMenuOpen(next); if (next) closeNow(); }}
      open={menuOpen}
    >
      <ContextMenuTrigger render={rowButton} />
      <ContextMenuContent>
        {suggestion ? (
          <>
            <ContextMenuGroup>
              <ContextMenuLabel>{suggestion.verb} suggested</ContextMenuLabel>
              {suggestion.reason ? (
                <div className="max-w-64 px-2 pb-1.5 text-[11px] leading-[1.4] text-muted-foreground">
                  {suggestion.reason}
                </div>
              ) : null}
              {suggestion.actionable ? (
                <ContextMenuItem onClick={() => onLifecycle(session!, "complete")}>
                  <CheckIcon />
                  Mark done
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem onClick={() => onDismiss(session!)}>
                <CloseIcon />
                Dismiss verdict
              </ContextMenuItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
          </>
        ) : null}

        <ContextMenuGroup>
          <ContextMenuLabel>Lifecycle</ContextMenuLabel>
          {session && completed ? (
            <ContextMenuItem onClick={() => onLifecycle(session, "uncomplete")}>
              <CheckIcon />
              Reopen
            </ContextMenuItem>
          ) : null}
          {session && !completed ? (
            <ContextMenuItem onClick={() => onLifecycle(session, saved ? "unsave" : "save")}>
              <BookmarkIcon />
              {saved ? "Move to Active" : "Save for later"}
            </ContextMenuItem>
          ) : null}
          {session && !completed ? (
            <ContextMenuItem onClick={() => onLifecycle(session, "complete")}>
              <CheckIcon />
              Mark done
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem disabled={!pinnable} onClick={() => onPin(row, !row.pinned)}>
            {row.pinned ? <PinOffIcon /> : <PinIcon />}
            {row.pinned ? "Unpin" : "Pin to top"}
          </ContextMenuItem>
        </ContextMenuGroup>

        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuLabel>Session</ContextMenuLabel>
          {session?.summary ? (
            <>
              <FullSummarySubmenu category={session.category} summary={session.summary} />
              <ContextMenuItem
                onClick={() => {
                  void navigator.clipboard.writeText(
                    summaryAsText(session.summary as SidebarSummary, row.name),
                  );
                }}
              >
                <CopyIcon />
                Copy summary
              </ContextMenuItem>
            </>
          ) : null}
          <ContextMenuItem disabled={!row.workspaceRef} onClick={() => onClose(row)}>
            <CloseIcon />
            Close tab
          </ContextMenuItem>
          {session ? (
            <ContextMenuItem onClick={() => onIncognito(session, !incognito)}>
              <MaskIcon />
              {incognito ? "Leave incognito" : "Make incognito"}
            </ContextMenuItem>
          ) : null}
        </ContextMenuGroup>

        {session ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              {/* Its own group at the bottom, away from Close tab. Closing a tab and erasing a
                  session are one row apart in a menu and a world apart in consequence. */}
              <ContextMenuItem
                className="text-destructive data-[highlighted]:text-destructive"
                onClick={() => onDestroy(session)}
              >
                <TrashIcon />
                Destroy…
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
