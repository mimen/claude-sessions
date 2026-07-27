/**
 * The session summary shown on hover. One card for the whole sidebar.
 *
 * The previous design gave every row its own card with its own open state, which made two cards on
 * screen at once not just possible but routine: nothing coordinated them, so any row whose
 * `mouseleave` was missed kept its card up while the next row opened another. Ownership is the fix.
 * There is one card, it belongs to the list, and it renders for at most one row, so the broken state
 * is unrepresentable rather than merely unlikely.
 *
 * It is a plain positioned panel rather than a popover primitive. Every such library anchors to a
 * trigger and keeps state per trigger, which is exactly the shape that produced the bug; and the
 * card needs none of what they provide -- it is never focused, never clicked, never dismissed by
 * escape, and must not take the pointer at all.
 */
import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SidebarSessionRow } from "../../projection.ts";
import { EmptySummaryCard, SummaryCard } from "./summary-card.tsx";

/** Which row the pointer is resting on, and where that row is on screen. */
export interface HoverTarget {
  readonly row: SidebarSessionRow;
  /** Viewport rect of the row, read when the hover settled. */
  readonly rect: DOMRect;
}

/** Narrow enough to read as an annotation on the row rather than a takeover of the sidebar. */
const CARD_WIDTH = 300;
const VIEWPORT_MARGIN = 8;
/** Gap between the row and the card, so the card is clearly about the row and not part of it. */
const ROW_GAP = 6;

export function HoverSummary({ target }: { target: HoverTarget | null }): React.ReactElement | null {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);

  // Measured after paint: the height depends on how much prose this particular session has, so it
  // cannot be known before the card exists. Until it is measured the card sits at the row's own
  // top, which is already close, so the correction is invisible rather than a visible jump.
  useLayoutEffect(() => {
    if (!target) return;
    const height = cardRef.current?.offsetHeight ?? 0;
    const preferred = target.rect.top;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    setTop(Math.max(VIEWPORT_MARGIN, Math.min(preferred, maxTop)));
  }, [target]);

  if (!target) return null;

  // Left of the sidebar when there is room, otherwise inside it. In cmux's left rail the sidebar is
  // flush against the screen edge, so "inside" is the normal case; the outside placement is what
  // keeps the card off the rows when the sidebar is docked right.
  const spaceLeft = target.rect.left;
  const left = spaceLeft >= CARD_WIDTH + VIEWPORT_MARGIN + ROW_GAP
    ? target.rect.left - CARD_WIDTH - ROW_GAP
    : Math.max(VIEWPORT_MARGIN, target.rect.right - CARD_WIDTH - VIEWPORT_MARGIN);

  return (
    <div
      // Never interactive. The card overlaps the rows beneath it, so taking the pointer would keep
      // it up while you reach for the next session and block the row you were reaching for.
      className="pointer-events-none fixed z-50 flex flex-col gap-2 rounded-md border border-border
        bg-popover p-2.5 text-popover-foreground shadow-lg"
      ref={cardRef}
      style={{ left, top, width: CARD_WIDTH }}
    >
      {target.row.summary
        ? <SummaryCard summary={target.row.summary} />
        : <EmptySummaryCard />}
    </div>
  );
}
