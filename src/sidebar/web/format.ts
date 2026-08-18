/** Display helpers for the sidebar rows. Pure, so they are tested without a DOM. */
import type { SidebarCategoryProjection } from "../category-projection.ts";
import type {
  SidebarDensity,
  SidebarMembership,
  SidebarSection,
  SidebarView,
} from "../projection.ts";

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
  completed: "Done",
  saved: "Saved",
  incognito: "Incognito",
};

/** Fixed order: the queue reads top to bottom by how much it wants attention. */
// The waiting states lead together: "needs you" and "ready" are both sessions holding for a
// human, so they sit above "working", which is handled and only needs watching.
// Live sessionless tabs outrank closed sessions: they are still on screen, "recent" is not.
// Finished work sits last: it is the least likely to need you, and collapsing it there keeps
// the live groups at the top where the eye starts.
// Incognito sits below the live queues and above finished work: everything in it is running, so
// it does not belong under "recent", but it is deliberately not competing with the sections that
// are asking for attention either.
export const SECTION_ORDER: readonly SidebarSection[] =
  ["needs-you", "ready", "working", "other", "incognito", "recent", "saved", "completed"];

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
export function emptyStateMessage(
  query: string,
  livenessReadable: boolean,
  view: SidebarView = "active",
): string | null {
  if (!livenessReadable) return null;
  if (query.trim().length > 0) return "No sessions match.";
  if (view === "saved") {
    return "Nothing saved. Save a session to keep it out of the way without losing it.";
  }
  if (view === "completed") return "Nothing finished yet.";
  if (view === "triage") return "No verdicts waiting.";
  return "Nothing running.";
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
export type GroupingMode = "status" | "project" | "category" | "recent";

export const GROUPING_MODES: readonly GroupingMode[] = ["status", "project", "category", "recent"];

export const GROUPING_LABELS: Readonly<Record<GroupingMode, string>> = {
  status: "By status",
  project: "By project",
  category: "By category",
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

/**
 * How much room a row gives the title, and how many lines it spends to do it.
 *
 * Measured on a real catalogue, the title is 388px wide in every layout except `compact`, where
 * status sits beside it and cuts it to 286px. The third line therefore buys hierarchy, not width.
 */
export type RowLayout = "compact" | "wide" | "three-line";

export const ROW_LAYOUTS: readonly RowLayout[] = ["wide", "compact", "three-line"];

export const ROW_LAYOUT_LABELS: Readonly<Record<RowLayout, string>> = {
  wide: "Wide title",
  compact: "Status beside title",
  "three-line": "Three lines",
};

/**
 * Open and closed rows are chosen separately, and the same choice does not cost the same on both.
 *
 * Almost every row in the list is closed, so a third line there is what actually lengthens the
 * scroll; the handful of open rows can afford one for a fraction of a percent. Stating the cost
 * per side is the point of splitting the control, so the hints differ rather than being shared.
 */
export const ROW_LAYOUT_HINTS_OPEN: Readonly<Record<RowLayout, string>> = {
  wide: "Title spans the row.",
  compact: "Status and age beside the title, shortening it.",
  "three-line": "Project and status above, title, category below.",
};

export const ROW_LAYOUT_HINTS_CLOSED: Readonly<Record<RowLayout, string>> = {
  wide: "Title spans the row.",
  compact: "Age beside the title, shortening it.",
  "three-line": "Project above, title, category below. Much longer list.",
};

/** The layout of a row depends on whether its session is still running. */
export interface RowLayouts {
  readonly open: RowLayout;
  readonly closed: RowLayout;
}

/** Only a value the app actually understands survives a round trip through storage. */
export function parseRowLayout(value: string | null): RowLayout {
  return ROW_LAYOUTS.includes(value as RowLayout) ? (value as RowLayout) : "wide";
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
  /** A colour the group claims, when it has one. Clusters and categories do; time bands do not. */
  readonly color?: string;
  /** Keep an intentional mark for a category state that has no registry colour. */
  readonly outlineMark?: boolean;
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
  /** Present when the session belongs to a cluster. */
  readonly membership?: SidebarMembership | null;
  /** Absent for sessionless tabs; null when the category projection itself was unavailable. */
  readonly category?: SidebarCategoryProjection | null;
}

/**
 * A cluster's colour, derived from its name rather than read from cmux.
 *
 * cmux can set a workspace colour but reports it nowhere, so mirroring is not available. Deriving
 * is better regardless: the colour holds whether or not a workspace is open, where a mirrored one
 * would vanish the moment the session closed.
 */
export function clusterColor(cluster: string): string {
  let hash = 0;
  for (const character of cluster) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  // Fixed saturation and lightness so every cluster reads as the same kind of mark and only the
  // hue distinguishes them.
  return `oklch(0.65 0.14 ${Math.abs(hash) % 360})`;
}

/**
 * Cluster sessions lifted into their own groups at the top.
 *
 * They MOVE rather than copy: a session has exactly one home, so the counts everywhere else stay
 * honest. Core roles lead each cluster because a coordinator is the way in, and its fleet follows.
 */
function clusterGroups<Row extends GroupableRow>(
  rows: readonly Row[],
): { readonly groups: Array<SessionGroup<Row>>; readonly rest: Row[] } {
  const byCluster = new Map<string, Row[]>();
  const rest: Row[] = [];
  for (const row of rows) {
    const cluster = row.membership?.cluster;
    if (!cluster) { rest.push(row); continue; }
    const bucket = byCluster.get(cluster);
    if (bucket) bucket.push(row); else byCluster.set(cluster, [row]);
  }
  const groups = [...byCluster.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cluster, members]) => ({
      key: `cluster:${cluster}`,
      label: cluster,
      color: clusterColor(cluster),
      rows: members.sort((left, right) => {
        const leftCore = left.membership?.kind === "core";
        const rightCore = right.membership?.kind === "core";
        if (leftCore !== rightCore) return leftCore ? -1 : 1;
        return byWaitingLongest(left, right);
      }),
    }));
  return { groups, rest };
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
  clusterFirst = false,
): Array<SessionGroup<Row>> {
  // Clusters are lifted before anything else, so their members never reach the pinned or status
  // grouping below and cannot appear twice.
  const lifted = clusterFirst ? clusterGroups(rows) : { groups: [], rest: [...rows] };
  const pinned = lifted.rest.filter((row) => row.pinned);
  const rest = lifted.rest.filter((row) => !row.pinned);
  const pinnedGroup: Array<SessionGroup<Row>> = pinned.length > 0
    ? [{ key: "pinned", label: "Pinned", rows: [...pinned].sort(openFirst(byWaitingLongest)) }]
    : [];
  return [...lifted.groups, ...pinnedGroup, ...groupUnpinned(rest, mode, now)];
}

interface CategoryBucket<Row> extends SessionGroup<Row> {
  readonly order: number;
  readonly rows: Row[];
}

/**
 * Registry order reaches this function on each projected row, so category shelving follows the
 * canonical hue wheel without a web-owned slug list that could drift from it.
 */
function categoryGroups<Row extends GroupableRow>(rows: readonly Row[]): Array<SessionGroup<Row>> {
  const buckets = new Map<string, CategoryBucket<Row>>();
  for (const row of rows) {
    const category = row.category;
    let seed: Omit<CategoryBucket<Row>, "rows">;
    if (category === undefined) {
      seed = { key: "category:not-applicable", label: "Other tabs", order: Number.MAX_SAFE_INTEGER - 2 };
    } else if (category === null) {
      seed = { key: "category:unavailable", label: "Category unavailable", order: Number.MAX_SAFE_INTEGER - 1 };
    } else if (category.effectiveSlug === null) {
      seed = {
        key: "category:uncategorized",
        label: "Uncategorized",
        order: Number.MAX_SAFE_INTEGER,
        outlineMark: true,
      };
    } else {
      seed = {
        key: `category:${category.effectiveSlug}`,
        label: category.compactLabel ?? category.fullLabel ?? category.effectiveSlug,
        order: category.order ?? Number.MAX_SAFE_INTEGER - 3,
        color: category.hex ?? undefined,
      };
    }
    const bucket = buckets.get(seed.key);
    if (bucket) bucket.rows.push(row);
    else buckets.set(seed.key, { ...seed, rows: [row] });
  }
  return [...buckets.values()]
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .map(({ order: _order, ...group }) => ({
      ...group,
      rows: [...group.rows].sort(pinnedFirst(openFirst(byRecency))),
    }));
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

  if (mode === "category") return categoryGroups(rows);

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
      // Live status sections are queues, so the longest-waiting work leads. Recent is history,
      // where the newest session is the useful entry point and therefore belongs at the top.
      rows: rows.filter((row) => row.section === section)
        .sort(pinnedFirst(openFirst(section === "recent" ? byRecency : byWaitingLongest))),
    }))
    .filter((group) => group.rows.length > 0);
}

/**
 * How much of a group is showing.
 *
 * Two independent facts rather than three stops on one cycle. They answer different questions --
 * "do I want this group at all" and "do I want its history" -- and a cycle forced you to pass
 * through one answer to reach the other. Keeping them apart also means the filter survives
 * shelving: unshelve a group and it comes back the way you left it.
 */
export interface ShelfState {
  readonly shelved: boolean;
  /** Show only rows backed by something running. Kept even while shelved, so it is not forgotten. */
  readonly liveOnly: boolean;
}

export const OPEN_SHELF: ShelfState = { shelved: false, liveOnly: false };

/** A row backed by something currently running: an open session, or any cmux tab. */
export function isLiveRow(row: { readonly kind: string; readonly density?: SidebarDensity }): boolean {
  // A sessionless tab is live by definition: it is a workspace that is open right now. For a
  // session, `full` density is exactly "live and not finished", which the projection already
  // decided -- re-deriving it here would be a second opinion that could disagree.
  return row.kind === "workspace" || row.density === "full";
}

/**
 * Would filtering to live change what this group shows?
 *
 * Only a group holding BOTH kinds qualifies. Measured against the live sidebar, no group under
 * "by status" ever does -- the sections are already split by liveness, so the control there would
 * either do nothing or empty the group. It renders as plain text in that case rather than as a
 * button that answers a click with nothing.
 */
export function canFilterLive(rows: readonly { readonly kind: string; readonly density?: SidebarDensity }[]): boolean {
  let live = false;
  let other = false;
  for (const row of rows) {
    if (isLiveRow(row)) live = true;
    else other = true;
    if (live && other) return true;
  }
  return false;
}

export function toggleShelved(state: ShelfState): ShelfState {
  return { ...state, shelved: !state.shelved };
}

export function toggleLiveOnly(state: ShelfState): ShelfState {
  return { ...state, liveOnly: !state.liveOnly };
}

/** The rows a state actually shows. */
export function shelfRows<Row extends { readonly kind: string; readonly density?: SidebarDensity }>(
  rows: readonly Row[],
  state: ShelfState,
): readonly Row[] {
  if (state.shelved) return [];
  return state.liveOnly ? rows.filter(isLiveRow) : rows;
}

/** Storage form. Compact enough to stay readable in devtools. */
function encodeShelfState(state: ShelfState): string {
  if (state.shelved) return state.liveOnly ? "collapsed-live" : "collapsed";
  return state.liveOnly ? "live" : "all";
}

function decodeShelfState(value: unknown): ShelfState | null {
  switch (value) {
    case "all": return OPEN_SHELF;
    case "live": return { shelved: false, liveOnly: true };
    case "collapsed": return { shelved: true, liveOnly: false };
    case "collapsed-live": return { shelved: true, liveOnly: true };
    default: return null;
  }
}

/**
 * Shelf states read back from storage.
 *
 * Two older formats are still accepted, because both exist in the wild: a bare array of collapsed
 * keys, and the three-state cycle that briefly replaced it. Dropping either would silently reopen
 * every section someone had shelved.
 */
export function parseShelfStates(raw: string | null): Map<string, ShelfState> {
  const fallback = (): Map<string, ShelfState> => new Map();
  if (raw === null) return fallback();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return new Map(parsed.filter((key): key is string => typeof key === "string")
        .map((key) => [key, { shelved: true, liveOnly: false }]));
    }
    if (parsed !== null && typeof parsed === "object") {
      const states = new Map<string, ShelfState>();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const state = decodeShelfState(value);
        if (state) states.set(key, state);
      }
      return states;
    }
    return fallback();
  } catch {
    return fallback();
  }
}

export function serializeShelfStates(states: ReadonlyMap<string, ShelfState>): string {
  return JSON.stringify(
    Object.fromEntries([...states].map(([key, state]) => [key, encodeShelfState(state)])),
  );
}
