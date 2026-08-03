/**
 * One session in the queue.
 *
 * The row answers "is this the one I want?" and nothing more: project, what the session is,
 * which model, how long since it moved, and cmux's own status. Everything else — the full path,
 * the worktree, the branch — lives in the hover preview, so a worktree-heavy fleet still reads
 * as one line of work per row.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarRow, SidebarSessionRow, SidebarSummary } from "../../projection.ts";
import { relativeTime, shortenPath } from "../format.ts";
import { cn } from "@/lib/utils";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { BRAND_ICON_SVGS } from "../brand-icons.ts";
import {
  ArchiveIcon,
  CheckIcon,
  CloseIcon,
  CopyIcon,
  FolderIcon,
  PinIcon,
  PinOffIcon,
} from "./icons.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { StatusIcon } from "./status-icon.tsx";
import { RowAction } from "./row-action.tsx";
import { summaryAsText } from "./summary-card.tsx";

/**
 * cmux's status words mapped onto the vendored component's four states. cmux owns the label;
 * this only decides which of the component's colours carries it.
 */
function statusTone(section: SidebarRow["section"]): "online" | "offline" | "maintenance" | "degraded" {
  if (section === "needs-you") return "degraded";
  if (section === "working") return "maintenance";
  return "online";
}

/**
 * The vendor's published logo, inlined and never recoloured. An unrecognised provider gets no
 * mark rather than an invented one.
 */
function ModelMark({ provider }: { provider: string }): React.ReactElement | null {
  const svg = provider === "anthropic"
    ? BRAND_ICON_SVGS.claudeColor
    : provider === "openai"
      ? BRAND_ICON_SVGS.openai
      : null;
  if (!svg) return null;
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-3 shrink-0 [&>svg]:size-full dark:[&_path[fill='#000']]:fill-white"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

/**
 * What a sessionless tab actually is, in cmux's own words. Duplicates collapse so a workspace
 * holding three terminals reads "terminal", not "terminal, terminal, terminal".
 */
function surfaceSummary(kinds: readonly string[]): string {
  const distinct = [...new Set(kinds)];
  return distinct.length > 0 ? distinct.join(" · ") : "empty";
}

/**
 * The project's own icon when it publishes one, else a folder glyph.
 *
 * A generic shape rather than an empty outlined box: the earlier placeholder read as an
 * unchecked checkbox, which invited a click that did nothing.
 */
function ProjectIcon({ source }: { source: string | null }): React.ReactElement {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);

  if (source && !failed) {
    return (
      <img
        alt=""
        className="size-3.5 shrink-0 rounded-[3px] object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
        src={source}
      />
    );
  }

  return <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />;
}

export interface SessionRowProps {
  /** Lifecycle actions replace the model and time on hover, so nothing shifts. */
  readonly onLifecycle: (row: SidebarSessionRow, action: "complete" | "archive" | "uncomplete" | "unarchive") => void;
  /** Closes the cmux workspace; the session itself is untouched. */
  readonly onClose: (row: SidebarRow) => void;
  /** Pins or unpins the row's cmux workspace. */
  readonly onPin: (row: SidebarRow, pinned: boolean) => void;
  readonly row: SidebarRow;
  readonly now: number;
  readonly selected: boolean;
  /** Reveals the ⌘N badge; true only while Command is held and this page has focus. */
  readonly showShortcut: boolean;
  readonly opening: boolean;
  readonly onOpen: (row: SidebarRow) => void;
  readonly registerRef: (element: HTMLButtonElement | null) => void;
  /**
   * Report that the pointer entered this row, or left it (null). The list owns the one summary
   * card; a row only says where the mouse is, which is the only thing it actually knows.
   */
  readonly onHover: (row: SidebarRow, element: HTMLElement | null) => void;
}

export function SessionRow({
  row,
  now,
  selected,
  showShortcut,
  opening,
  onOpen,
  onLifecycle,
  onClose,
  onPin,
  registerRef,
  onHover,
}: SessionRowProps): React.ReactElement {
  // Only a session has a lifecycle to act on. A browser split or plain shell is navigation
  // only: there is nothing to complete, archive, or enrich, so it gets no lifecycle controls.
  const [menuOpen, setMenuOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const closeNow = useCallback((): void => setCardOpen(false), []);
  const session = row.kind === "session" ? row : null;
  const workspace = row.kind === "workspace" ? row : null;
  const archived = session?.lifecycle === "archived";
  const completed = session?.lifecycle === "completed";
  // Pins live on the cmux workspace, so a row with no workspace has nothing to pin.
  const pinnable = row.workspaceId !== null;

  const rowButton = (
    <button
      aria-busy={opening}
      aria-selected={selected}
      // The row is a real card: on a near-black surface a transparent row has no edge at all,
      // so the list reads as one undifferentiated block of text.
      // Hover and selection were both faint overlays and read the same. Hover now lifts the
      // surface a clear step; selection additionally carries an accent edge, so the current row
      // is identifiable without comparing shades.
      className={cn(
        "group relative mb-1.5 block w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left",
        "bg-card transition-colors duration-75",
        "before:absolute before:inset-y-0 before:left-0 before:w-[2px] before:bg-transparent",
        "hover:bg-secondary",
        "focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2",
        row.focused && "bg-secondary before:bg-primary",
        // Unread rides the same left edge the focused row uses, in cmux's notification blue. A
        // badge sat inside the row and pushed the title around, so the one row with news was also
        // the one row laid out differently; an edge mark says the same thing from outside the
        // content. Focused wins the edge when both apply: it is where you are, which you need to
        // know before you need to know what changed, and the unread is about to clear anyway.
        !row.focused && row.unread > 0 && "before:bg-[#4C8DFF]",
        selected && !row.focused && "ring-1 ring-ring/60 ring-inset",
        opening && "cursor-progress opacity-70",
      )}
      data-row-id={row.id}
      data-section={row.section}
      onClick={() => { if (!opening) onOpen(row); }}
      ref={registerRef}
      type="button"
    >
      {/*
        * Two columns rather than two full-width rows. The right column is the fixed-width
        * metadata stack, so the left column owns everything else — which lets a long session
        * name wrap to a second line instead of truncating, and costs one line of height only
        * on the rows that actually need it.
        */}
      <span className="flex items-stretch gap-2">
        <span className="flex min-w-0 flex-1 flex-col justify-between">
          {/* The project line needs air under it: at 10px directly above a 13px title the two read
            * as one wrapped string rather than as label-then-thing. */}
          <span className="mb-[2px] flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <ProjectIcon source={row.faviconUrl} />
            <span className="truncate">{row.directory ?? shortenPath(row.directoryPath)}</span>
            {/*
              * Pinned rows only. cmux keeps pins at the top of its own order, so their number is
              * stable; every other row's position shifts as workspaces come and go, and a badge
              * that silently went stale would be worse than no badge.
              */}
          </span>
          <span className="flex items-end gap-1.5">
            {/* The edge mark carries "there is news" but not how much, so the count survives here
              * for anything reading the row rather than looking at it. */}
            {row.unread > 0 ? <span className="sr-only">{row.unread} unread</span> : null}
            <span
              className={cn(
                "line-clamp-2 text-[13px] leading-5 text-foreground",
                row.section === "needs-you" ? "font-semibold" : "font-medium",
                row.section === "recent" && "font-normal text-muted-foreground",
              )}
            >
              {row.name}
            </span>
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1">
          {/*
            * Lifecycle lives on hover: it is a deliberate act, not something to invite on every
            * pass down the queue. Stopping propagation keeps it from also opening the session.
            */}

          {/*
            * cmux's own label when it published one. When it did not — CCS clears the pill for
            * loop workers so it does not fight its own tab painting — the badge says the one
            * thing we actually know: the session is live. It never guesses "Idle".
            */}
          {/*
            * Lives in the right column beside the status pill so every badge shares one right
            * edge. In the left column it right-aligned to a boundary that shifted with the pill's
            * width, so ⌘1 and ⌘2 landed at different x positions.
            */}
          <span className="flex items-center gap-1.5">
            {row.pinned && row.shortcut !== null && showShortcut ? (
              <span className="flex shrink-0 items-center rounded-(--radius) border border-border bg-muted/60 px-1 font-mono text-[9px] leading-[14px] text-foreground/80">
                ⌘{row.shortcut}
              </span>
            ) : null}
          {row.status ? (
            /*
             * No pill. Its background matched the focused row's exactly, so the shape vanished on
             * the one row you were looking at; bordering it only in that state was a patch on a
             * container that was not earning its keep. The icon already carries cmux's colour.
             */
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <StatusIcon color={row.status.color} icon={row.status.icon} />
              {row.status.label}
            </span>
          ) : session && row.workspaceRef ? (
            <Status
              className="gap-1 border-0 bg-transparent px-0 py-0 text-[10px] text-muted-foreground"
              status={statusTone(row.section)}
            >
              <StatusIndicator />
              <StatusLabel>Live</StatusLabel>
            </Status>
          ) : null}
          </span>
          <span
            className={cn(
              "mt-auto flex h-5 items-center gap-1.5 text-[11px] text-muted-foreground",
              "group-hover:hidden",
            )}
          >
            {session?.model ? (
              <span
                className="flex items-center gap-1 text-[10px] font-normal"
                style={{ color: session.model.color }}
              >
                {session.model.label}
                <ModelMark provider={session.model.provider} />
              </span>
            ) : null}
            {/* A sessionless tab has no activity clock, so it says what it is instead. */}
            {session
              ? <span className="tabular-nums">{relativeTime(row.lastActivityAt, now)}</span>
              : <span className="text-[10px]">{surfaceSummary(workspace?.surfaceKinds ?? [])}</span>}
          </span>

          {/*
            * A sessionless tab gets the close control only: there is no lifecycle to complete or
            * archive, but it is still a tab you need to be able to shut.
            */}
          {workspace ? (
            <span className="mt-auto hidden h-5 items-center gap-1 group-hover:flex">
              <RowAction label="Close tab" onClick={() => onClose(workspace)} tone="destroy">
                <CloseIcon className="size-3" />
              </RowAction>
            </span>
          ) : null}

          {session ? (
            /*
             * Reaching for a lifecycle control IS the moment the summary is worth reading, so the
             * controls are the trigger. It had its own button, which cost a slot on every row to
             * answer a question you only ask when deciding -- and by then your pointer is already
             * here. Moving down the list still fires nothing: the controls appear on row hover, so
             * the card needs a deliberate move onto one.
             */
            <span className="mt-auto hidden h-5 items-center gap-1 group-hover:flex">
              {/*
                * A finished session offers only the way back. Showing "Archive" next to a
                * completed row invited a second terminal state that says nothing new, and
                * "Complete" on an already-completed row is a no-op dressed as an action.
                */}
              {!archived ? (
                <RowAction
                  label={completed ? "Mark not complete" : "Complete"}
                  onClick={() => onLifecycle(session, completed ? "uncomplete" : "complete")}
                  onHover={(anchor) => onHover(row, anchor)}
                  tone="confirm"
                >
                  <CheckIcon className="size-3" />
                </RowAction>
              ) : null}
              {!completed ? (
                <RowAction
                  label={archived ? "Unarchive" : "Archive"}
                  onClick={() => onLifecycle(session, archived ? "unarchive" : "archive")}
                  onHover={(anchor) => onHover(row, anchor)}
                  tone="shelve"
                >
                  <ArchiveIcon className="size-2.5" />
                </RowAction>
              ) : null}
              <RowAction
                disabled={!row.workspaceRef}
                label={row.workspaceRef ? "Close workspace" : "No workspace to close"}
                onClick={() => onClose(session)}
                onHover={(anchor) => onHover(row, anchor)}
                tone="dismiss"
              >
                <CloseIcon className="size-3" />
              </RowAction>
            </span>
          ) : null}
        </span>

      </span>
    </button>
  );

  const summary = session?.summary ?? null;

  const menu = (
    <ContextMenu
      onOpenChange={(next) => { setMenuOpen(next); if (next) closeNow(); }}
      open={menuOpen}
    >
      {/* `render` hands Base UI the row itself, so the card stays one element and one tab stop. */}
      <ContextMenuTrigger
        // The delay is the whole design: summaries sit on nearly every row, so an instant card
        // would fire a paragraph under the cursor on every row you scan past. At ~600ms it only
        // appears when you deliberately rest on one.
        render={rowButton}
      />
      <ContextMenuContent>
        <ContextMenuItem
          disabled={!pinnable}
          onClick={() => onPin(row, !row.pinned)}
        >
          {row.pinned ? <PinOffIcon /> : <PinIcon />}
          {row.pinned ? "Unpin" : "Pin to top"}
        </ContextMenuItem>
        {session ? (
          <>
            <ContextMenuSeparator />
            {!archived ? (
              <ContextMenuItem onClick={() => onLifecycle(session, completed ? "uncomplete" : "complete")}>
                <CheckIcon />
                {completed ? "Mark not complete" : "Complete"}
              </ContextMenuItem>
            ) : null}
            {!completed ? (
              <ContextMenuItem onClick={() => onLifecycle(session, archived ? "unarchive" : "archive")}>
                <ArchiveIcon />
                {archived ? "Unarchive" : "Archive"}
              </ContextMenuItem>
            ) : null}
          </>
        ) : null}
        {session?.summary ? (
          <>
            <ContextMenuSeparator />
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
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!row.workspaceRef} onClick={() => onClose(row)}>
          <CloseIcon />
          {workspace ? "Close tab" : "Close workspace"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  return menu;
}

