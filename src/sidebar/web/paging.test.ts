/**
 * When the list is allowed to ask for more rows.
 *
 * The rule this encodes is the one the sidebar got wrong: how many rows are ON SCREEN says
 * nothing about whether the server has more. Most of what its scan reads never reaches the
 * client -- 2107 of 2623 sessions on the live store are delegated seats, filtered before
 * projection -- so a response carrying 58 rows can sit on a scan of 160.
 */
import { test, expect } from "bun:test";
import { shouldRequestMoreRows } from "./paging.ts";

const PAGE = 40;
const THRESHOLD = 240;

test("nothing is requested until the end of the list is near", () => {
  expect(shouldRequestMoreRows({
    remainingPx: THRESHOLD + 1,
    thresholdPx: THRESHOLD,
    hasMoreRows: true,
  })).toBe(false);
});

test("reaching the end asks for more while the server has more", () => {
  expect(shouldRequestMoreRows({ remainingPx: 0, thresholdPx: THRESHOLD, hasMoreRows: true })).toBe(true);
  expect(shouldRequestMoreRows({ remainingPx: THRESHOLD, thresholdPx: THRESHOLD, hasMoreRows: true })).toBe(true);
});

test("a server that has run out is not asked again", () => {
  expect(shouldRequestMoreRows({ remainingPx: 0, thresholdPx: THRESHOLD, hasMoreRows: false })).toBe(false);
});

// The regression. The old guard was `window > visibleRows + PAGE`, so heavy server-side filtering
// latched it shut: once the window outran what survived to the screen it never grew again, and
// the list stopped roughly 75 rows in -- a week of history against three months of sessions.
test("heavy server-side filtering does not stop paging", () => {
  // A window of 160 that yielded 58 visible rows: the old rule refused (160 > 58 + 40), this one
  // asks, because the server said its scan was still full.
  expect(shouldRequestMoreRows({
    remainingPx: 0,
    thresholdPx: THRESHOLD,
    hasMoreRows: true,
    // Present only to document the shape that used to defeat it; the decision must not use them.
    windowSize: 160,
    visibleRows: 58,
  })).toBe(true);
  expect(shouldRequestMoreRows({
    remainingPx: 0,
    thresholdPx: THRESHOLD,
    hasMoreRows: true,
    windowSize: 2000,
    visibleRows: 1,
  })).toBe(true);
});

// Before the first response there is nothing to say the server is exhausted, and refusing to page
// on an absent fact would leave the list stuck at its opening window.
test("an unknown answer pages rather than stalling", () => {
  expect(shouldRequestMoreRows({ remainingPx: 0, thresholdPx: THRESHOLD, hasMoreRows: undefined })).toBe(true);
});

test("the page size is not part of the decision", () => {
  for (const page of [1, PAGE, 500]) {
    expect(shouldRequestMoreRows({
      remainingPx: 0, thresholdPx: THRESHOLD, hasMoreRows: true, pageSize: page,
    })).toBe(true);
  }
});
