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

/**
 * Narrow enough to read as an annotation on the row rather than a takeover of the sidebar.
 *
 * The dock is itself only a few hundred pixels wide, so a card sized as a fraction of the
 * viewport is indistinguishable from a full-width panel. A fixed, deliberately small width is
 * what makes it read as a note about a row.
 */
const CARD_WIDTH = 240;
const VIEWPORT_MARGIN = 8;
/** Gap between the row and the card, so the card is clearly about the row and not part of it. */
const ROW_GAP = 6;

interface Placement {
  readonly top: number;
  readonly left: number;
}

export function HoverSummary({ target }: { target: HoverTarget | null }): React.ReactElement | null {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Placement needs the card's height, which depends on how much prose this particular session has,
  // so it cannot be known until the card exists. It is therefore rendered hidden for one frame and
  // positioned here -- hidden rather than at a guessed position, because a card that visibly jumps
  // is worse than one that appears a frame later.
  useLayoutEffect(() => {
    if (!target) {
      setPlacement(null);
      return;
    }
    const height = cardRef.current?.offsetHeight ?? 0;
    const below = target.rect.bottom + ROW_GAP;
    const above = target.rect.top - height - ROW_GAP;

    // Below the row by default, flipping above only when the card would run off the bottom. Never
    // over the row: the row is what the card is describing, and covering it takes away the thing
    // you were reading about.
    const fitsBelow = below + height + VIEWPORT_MARGIN <= window.innerHeight;
    const fitsAbove = above >= VIEWPORT_MARGIN;
    const top = fitsBelow || !fitsAbove
      ? Math.min(below, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN))
      : above;

    // Left-aligned with the row, clamped so a card near the edge stays fully on screen.
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, target.rect.left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN),
    );
    setPlacement({ top, left });
  }, [target]);

  if (!target) return null;

  return (
    <div
      // Never interactive. The card overlaps whatever is beneath it, so taking the pointer would
      // keep it up while you reach for the next session and block the row you were reaching for.
      className="pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded-md border border-border
        bg-popover px-2 py-1.5 text-popover-foreground shadow-lg"
      ref={cardRef}
      style={{
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        width: CARD_WIDTH,
        visibility: placement ? "visible" : "hidden",
      }}
    >
      {target.row.summary
        ? <SummaryCard summary={target.row.summary} />
        : <EmptySummaryCard />}
    </div>
  );
}
