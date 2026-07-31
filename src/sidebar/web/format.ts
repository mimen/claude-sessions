/** Display helpers for the sidebar rows. Pure, so they are tested without a DOM. */
import type { SidebarDensity, SidebarSection, SidebarView } from "../projection.ts";

/**
 * Time since the last activity, at the coarsest unit that still distinguishes rows.
 * "now" under a minute, then minutes, hours, days — a work queue never needs seconds.
 */
export function relativeTime(timestamp: number | null, now: number): string {
  if (timestamp === null) return "";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

export const SECTION_LABELS: Readonly<Record<SidebarSection, string>> = {
  "needs-you": "Needs you",
  other: "Other tabs",
  working: "Working",
  ready: "Ready",
  recent: "Recent",
  completed: "Complete",
  archived: "Archived",
};

/** Fixed order: the queue reads top to bottom by how much it wants attention. */
// Live sessionless tabs outrank closed sessions: they are still on screen, "recent" is not.
// Finished work sits last: it is the least likely to need you, and collapsing it there keeps
// the live groups at the top where the eye starts.
export const SECTION_ORDER: readonly SidebarSection[] =
  ["needs-you", "working", "ready", "other", "recent", "completed", "archived"];

/** A response may update the view only when it belongs to the selected scope and is newest. */
export function shouldApplySnapshotResponse(
  responseScope: SidebarView,
  selectedScope: SidebarView,
  requestId: number,
  latestAppliedRequestId: number,
): boolean {
  return responseScope === selectedScope && requestId > latestAppliedRequestId;
}

/** Reload only for an explicit freshness request or when the selected scope changed in flight. */
export function shouldReloadSnapshot(
  responseScope: SidebarView,
  selectedScope: SidebarView,
  freshReloadQueued: boolean,
): boolean {
  return freshReloadQueued || responseScope !== selectedScope;
}

/** An unreadable cmux state cannot support a truthful claim that the queue is empty. */
export function emptyStateMessage(query: string, livenessReadable: boolean): string | null {
  if (!livenessReadable) return null;
  return query.trim().length > 0 ? "No sessions match." : "Nothing running.";
}

/**
 * A middle-truncated path, so both the repository and the leaf stay readable in a narrow dock.
 */
export function shortenPath(path: string | null, maxLength = 34): string {
  if (!path) return "";
  const home = path.replace(/^\/Users\/[^/]+/, "~");
  if (home.length <= maxLength) return home;
  const segments = home.split("/");
  const tail = segments.slice(-2).join("/");
  return tail.length + 2 <= maxLength ? `…/${tail}` : `…${home.slice(-(maxLength - 1))}`;
}

/** How the queue is arranged. One control cycles these; the choice is remembered. */
export type GroupingMode = "status" | "project" | "recent";

export const GROUPING_MODES: readonly GroupingMode[] = ["status", "project", "recent"];

export const GROUPING_LABELS: Readonly<Record<GroupingMode, string>> = {
  status: "By status",
  project: "By project",
  recent: "Most recent",
};

/** The next mode in the cycle, wrapping at the end. */
export function nextGroupingMode(mode: GroupingMode): GroupingMode {
  const index = GROUPING_MODES.indexOf(mode);
  return GROUPING_MODES[(index + 1) % GROUPING_MODES.length] ?? "status";
}

/** Only a value the app actually understands survives a round trip through storage. */
export function parseGroupingMode(value: string | null): GroupingMode {
  return GROUPING_MODES.includes(value as GroupingMode) ? (value as GroupingMode) : "status";
}

/** Age bands, coarsest boundaries people actually reason in. Order is display order. */
export const RECENCY_BANDS: readonly string[] = [
  "Last 2 hours",
  "Today",
  "This week",
  "Older",
  "Unknown",
];

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function recencyBand(lastActivityAt: number | null, now: number): string {
  if (lastActivityAt === null) return "Unknown";
  const age = now - lastActivityAt;
  if (age < TWO_HOURS_MS) return "Last 2 hours";
  if (age < DAY_MS) return "Today";
  if (age < WEEK_MS) return "This week";
  return "Older";
}

export interface SessionGroup<Row> {
  readonly key: string;
  /** Absent when the arrangement is one flat list that needs no heading. */
  readonly label: string | null;
  readonly rows: readonly Row[];
}

interface GroupableRow {
  readonly section: SidebarSection;
  readonly directory: string | null;
  readonly lastActivityAt: number | null;
  readonly pinned: boolean;
  /** Full for a live session; the collapsed densities are closed or settled work. */
  readonly density: SidebarDensity;
}

/**
 * Open work sits above closed work inside every group.
 *
 * A group is a queue of things that might need you, and a closed session cannot need you: it has
 * no live process to be waiting on anything. Interleaving the two by recency alone put one-line
 * closed rows between full cards, which broke the run of cards visually and buried live work
 * behind sessions that had merely been touched more recently.
 */
function openFirst<Row extends GroupableRow>(
  compare: (left: Row, right: Row) => number,
): (left: Row, right: Row) => number {
  return (left, right) => {
    const leftClosed = left.density !== "full";
    const rightClosed = right.density !== "full";
    if (leftClosed !== rightClosed) return leftClosed ? 1 : -1;
    return compare(left, right);
  };
}

/** A pin is an explicit instruction to keep something in view, so it outranks every other order. */
function pinnedFirst<Row extends GroupableRow>(
  compare: (left: Row, right: Row) => number,
): (left: Row, right: Row) => number {
  return (left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return compare(left, right);
  };
}

function byRecency(left: GroupableRow, right: GroupableRow): number {
  return (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0);
}

/** Longest-waiting first — a queue, so the thing that has been sitting longest is on top. */
function byWaitingLongest(left: GroupableRow, right: GroupableRow): number {
  return (left.lastActivityAt ?? Number.POSITIVE_INFINITY)
    - (right.lastActivityAt ?? Number.POSITIVE_INFINITY);
}

/**
 * Arrange rows for display.
 *
 * Status keeps cmux's own order inside each section so rows never jump mid-turn. Project and
 * recency are explicit re-orderings the user asked for, so sorting by activity is expected there.
 */
/**
 * Pinned work leads the list under every grouping.
 *
 * A pin says "keep this where I can find it", which only holds if its position does not depend on
 * the sort in effect. So pinned rows are lifted out into their own group at the top and removed
 * from the groups below rather than merely sorted first within them — otherwise switching to
 * project grouping would scatter them back down the list.
 */
export function groupSessions<Row extends GroupableRow>(
  rows: readonly Row[],
  mode: GroupingMode,
  now: number = Date.now(),
): Array<SessionGroup<Row>> {
  const pinned = rows.filter((row) => row.pinned);
  const rest = rows.filter((row) => !row.pinned);
  const pinnedGroup: Array<SessionGroup<Row>> = pinned.length > 0
    ? [{ key: "pinned", label: "Pinned", rows: [...pinned].sort(openFirst(byWaitingLongest)) }]
    : [];
  return [...pinnedGroup, ...groupUnpinned(rest, mode, now)];
}

function groupUnpinned<Row extends GroupableRow>(
  rows: readonly Row[],
  mode: GroupingMode,
  now: number,
): Array<SessionGroup<Row>> {
  if (mode === "recent") {
    // Ordering alone makes "how stale is this?" a matter of counting rows. Age bands answer it
    // directly, and the boundaries are the ones people actually reason in.
    const buckets = new Map<string, Row[]>();
    for (const row of [...rows].sort(pinnedFirst(openFirst(byRecency)))) {
      const band = recencyBand(row.lastActivityAt, now);
      const bucket = buckets.get(band);
      if (bucket) bucket.push(row);
      else buckets.set(band, [row]);
    }
    return RECENCY_BANDS
      .filter((band) => buckets.has(band))
      .map((band) => ({ key: band, label: band, rows: buckets.get(band) ?? [] }));
  }

  if (mode === "project") {
    const byProject = new Map<string, Row[]>();
    for (const row of rows) {
      const key = row.directory ?? "Elsewhere";
      const bucket = byProject.get(key);
      if (bucket) bucket.push(row);
      else byProject.set(key, [row]);
    }
    // Alphabetical, deliberately. Ordering projects by activity meant the headings reshuffled
    // under the cursor every few seconds; a stable order is worth more here than freshness,
    // which the rows themselves already carry.
    return [...byProject.entries()]
      .map(([key, projectRows]) => ({ key, label: key, rows: [...projectRows].sort(pinnedFirst(openFirst(byRecency))) }))
      .sort((left, right) => left.key.localeCompare(right.key, undefined, { sensitivity: "base" }));
  }

  return SECTION_ORDER
    .map((section) => ({
      key: section,
      label: SECTION_LABELS[section],
      // A status section is a queue: whatever has been waiting longest is at the top, so the
      // thing most overdue for attention is the first thing read. Pins still lead.
      rows: rows.filter((row) => row.section === section)
        .sort(pinnedFirst(openFirst(byWaitingLongest))),
    }))
    .filter((group) => group.rows.length > 0);
}
