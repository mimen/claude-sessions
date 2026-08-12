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
import { CategorySummary, EmptySummaryCard, SummaryCard } from "./summary-card.tsx";

/** Which row the pointer is resting on, and the element the card follows. */
export interface HoverTarget {
  readonly row: SidebarSessionRow;
  readonly element: HTMLElement;
  /** Initial viewport rect, so the hidden first render already has the row's final width. */
  readonly rect: DOMRect;
}

/**
 * The card mirrors the row it describes: same left edge, same width.
 *
 * A fixed narrow width left it hugging the sidebar's left edge with dead space beside it, which
 * read as a panel that had failed to size itself rather than a note attached to a row. Sharing the
 * row's edges is what makes the association legible, and in a dock a few hundred pixels wide the
 * row is already narrow enough that the card cannot become a takeover.
 *
 * Horizontal placement therefore takes no margin of its own — the row's inset is the margin, and
 * imposing a second one put the card two pixels inside the row it was supposed to line up with.
 */
const VIEWPORT_MARGIN = 8;
/** Gap between the row and the card, so the card is clearly about the row and not part of it. */
const ROW_GAP = 6;

interface Placement {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

export function HoverSummary({
  target,
  categoryProjectionError,
}: {
  readonly target: HoverTarget | null;
  readonly categoryProjectionError: string | null;
}): React.ReactElement | null {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  // Give the hidden card its final horizontal geometry before measuring it. Measuring at width zero
  // makes prose wrap into a very tall column; the subsequent real width shortens the card without
  // changing the already-calculated top, which detaches summaries from rows in the lower half.
  const width = target ? Math.min(target.rect.width, window.innerWidth) : 0;
  const left = target
    ? Math.max(0, Math.min(target.rect.left, window.innerWidth - width))
    : 0;

  // Placement needs the card's height, which depends on how much prose this particular session has,
  // so it cannot be known until the card exists at its final width. It is rendered hidden for one
  // frame and positioned here -- hidden rather than at a guessed position, because a card that
  // visibly jumps is worse than one that appears a frame later.
  useLayoutEffect(() => {
    if (!target) {
      setPlacement(null);
      return;
    }

    const place = (): void => {
      const height = cardRef.current?.offsetHeight ?? 0;
      const rect = target.element.getBoundingClientRect();
      const below = rect.bottom + ROW_GAP;
      const above = rect.top - height - ROW_GAP;

      // Below the row by default, flipping above only when the card would run off the bottom. Never
      // over the row: the row is what the card is describing, and covering it takes away the thing
      // you were reading about.
      const fitsBelow = below + height + VIEWPORT_MARGIN <= window.innerHeight;
      const fitsAbove = above >= VIEWPORT_MARGIN;
      const top = fitsBelow || !fitsAbove
        ? Math.min(below, Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN))
        : above;

      setPlacement({ top, left, width });
    };

    place();
    // The row lives in a nested scroll container and can also move when a polling update reorders a
    // section. Capture-phase scroll sees that container; resize covers the viewport changing around
    // it. Both refresh from the live element rather than the rect saved when hover began.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [left, target, width]);

  if (!target) return null;

  return (
    <div
      // Never interactive. The card overlaps whatever is beneath it, so taking the pointer would
      // keep it up while you reach for the next session and block the row you were reaching for.
      className="pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded-md border border-border
        bg-popover px-2 py-1.5 text-popover-foreground shadow-lg"
      ref={cardRef}
      style={{
        left,
        top: placement?.top ?? 0,
        width,
        visibility: placement ? "visible" : "hidden",
      }}
    >
      <CategorySummary category={target.row.category} error={categoryProjectionError} />
      {target.row.summary
        ? <SummaryCard summary={target.row.summary} />
        : <EmptySummaryCard />}
    </div>
  );
}
