/**
 * Whether to widen the row window.
 *
 * Its own module because the rule is worth stating once and testing: the previous version lived
 * inline in a scroll handler, where the only thing available to reason with was how many rows were
 * on screen -- and that is the one quantity that cannot answer the question. The server drops
 * delegated seats before projecting (2107 of 2623 sessions on the live store), so a response
 * carrying 58 rows can sit on a scan of 160. Comparing the window against the visible count
 * therefore latched the guard shut and stopped the list for good, about 75 rows in.
 *
 * Only the server knows whether its scan was still limit-bound, so only the server can answer it.
 */
export interface PagingInput {
  /** Pixels of unscrolled content left below the viewport. */
  readonly remainingPx: number;
  /** How close to the end counts as "near it". */
  readonly thresholdPx: number;
  /**
   * Whether the server's scan filled its window, and so may have more behind it. Undefined before
   * the first response, which pages: an absent fact is not a reason to stop.
   */
  readonly hasMoreRows: boolean | undefined;
  /** Accepted and deliberately unused -- see the note above about what cannot decide this. */
  readonly windowSize?: number;
  readonly visibleRows?: number;
  readonly pageSize?: number;
}

export function shouldRequestMoreRows(input: PagingInput): boolean {
  if (input.remainingPx > input.thresholdPx) return false;
  return input.hasMoreRows !== false;
}
