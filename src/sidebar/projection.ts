/**
 * The productivity sidebar's pure projection.
 *
 * One question drives the shape: what deserves attention next? Rows carry only what a person
 * needs to choose one — working directory, session name, worktree, model, cmux's own Claude
 * status, lifecycle, and recency. Cost, lineage, roles, and other catalogue metadata are absent.
 *
 * Every input is supplied by the caller so this module stays free of cmux, SQLite, and git I/O.
 */
import type { Lifecycle } from "../catalogue/db.ts";
import { familyOf } from "../tui/format.ts";

/** cmux's own `claude_code` status entry, exactly as cmux renders it. */
export interface CmuxClaudeStatus {
  readonly label: string;
  readonly icon: string | null;
  readonly color: string | null;
}

export type CmuxStatusAvailability =
  | "published"
  /** Inferred from the hook store while the authoritative pill is being re-read. */
  | "derived"
  | "absent"
  | "unreadable"
  | "not-live";

/** One live Claude session, joined from the cmux tree and hook store by surface UUID. */
export interface LiveSessionInput {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly windowId: string;
  readonly windowRef: string;
  readonly workspaceTitle: string | null;
  /** cmux's own pin on the workspace; pinned work leads its group. */
  readonly pinned: boolean;
  /** The ⌘N that jumps here, or null when nothing reaches it. */
  readonly shortcut: number | null;
  /** True for the workspace cmux currently has focused. */
  readonly focused: boolean;
  readonly cwd: string | null;
  /** cmux's rendered status pill for the workspace, when it publishes one. */
  readonly status: CmuxClaudeStatus | null;
  /** Whether cmux published no pill or the list-status command itself could not be read. */
  readonly statusAvailability: CmuxStatusAvailability;
  /** Unix seconds cmux last recorded for the session. */
  readonly updatedAt: number | null;
}

/**
 * One live cmux workspace that no Claude session owns.
 *
 * A plain shell, a browser split, a rendered markdown panel: cmux's own rail lists these, so a
 * sidebar that replaces it must reach them too, or those tabs become unnavigable. They carry no
 * session identity, no model, and no lifecycle — the union below keeps that absence in the type
 * rather than filling it with nulls a consumer might mistake for missing data.
 */
export interface LiveWorkspaceInput {
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly workspaceTitle: string | null;
  readonly windowId: string;
  readonly windowRef: string;
  readonly pinned: boolean;
  readonly focused: boolean;
  readonly shortcut: number | null;
  readonly cwd: string | null;
  /** cmux's surface types in tree order, e.g. `terminal`, `browser`, `filepreview`. */
  readonly surfaceKinds: readonly string[];
}

/** One indexed session, used for names, models, recency, and the resume shelf. */
export interface IndexedSessionInput {
  readonly sessionId: string;
  readonly resumeId: string;
  readonly title: string;
  readonly cwd: string | null;
  /** ISO timestamp of the session's last recorded activity. */
  readonly lastTs: string | null;
  readonly models: readonly string[];
  readonly costByModel: Readonly<Record<string, number>>;
  /** Transcript message count, used to age the enrichment summary. */
  readonly messageCount?: number | null;
}

/** The checkout a directory belongs to, when the directory is inside a git repository. */
export interface CheckoutInput {
  /** The repository's own name, identical across all of its worktrees. */
  readonly project: string;
  /** The linked worktree's name, or null when this is the repository's main checkout. */
  readonly worktree: string | null;
  readonly branch: string | null;
}

/** What enrichment concluded about a session, as the catalogue recorded it. */
export interface SessionEnrichment {
  /** What happened in the session. */
  readonly summary: string;
  /** Why the recommendation follows, in enrichment's own words. */
  readonly reason: string | null;
  /** What enrichment thinks should happen next. */
  readonly recommendation: string | null;
  /** Work explicitly left open. */
  readonly outstanding: string | null;
  /** Transcript message count when the summary was written. */
  readonly atMessages: number | null;
}

/** An enrichment record plus how far the transcript has moved since it was written. */
export interface SidebarSummary extends SessionEnrichment {
  /**
   * Messages appended since the summary was generated, or null when either count is unknown.
   * Messages rather than turns: the catalogue records a message count at enrichment time and
   * never recorded a turn count, so turns cannot be derived without inventing one.
   */
  readonly messagesSince: number | null;
}

export type SidebarLifecycle = "active" | "completed" | "archived";
export type SidebarScope = SidebarLifecycle;

export interface ProjectionInput {
  readonly live: readonly LiveSessionInput[];
  /** Live cmux workspaces no session owns; omitted entirely when the caller does not collect them. */
  readonly workspaces?: readonly LiveWorkspaceInput[];
  /** Every live cmux session id, including non-primary surfaces that do not get their own row. */
  readonly liveSessionIds?: ReadonlySet<string>;
  readonly indexed: readonly IndexedSessionInput[];
  /** Catalogue lifecycle keyed by canonical session id and any known resume alias. */
  readonly lifecycles?: ReadonlyMap<string, SidebarLifecycle>;
  /** Canonical catalogue id keyed by itself and any known resume alias. */
  readonly canonicalSessionIds?: ReadonlyMap<string, string>;
  /** Which lifecycle the caller is browsing. */
  readonly scope?: SidebarScope;
  /** Absolute directory -> its checkout, for whichever directories the caller resolved. */
  readonly checkouts: ReadonlyMap<string, CheckoutInput>;
  /** Absolute directories that publish a favicon; the row then links to the server's endpoint. */
  readonly faviconDirectories?: ReadonlySet<string>;
  /** Unread notification counts keyed by stable workspace UUID, as cmux reports them. */
  readonly unreadByWorkspaceId?: ReadonlyMap<string, number>;
  /** Enrichment records keyed by canonical session id and resume alias. */
  readonly summaries?: ReadonlyMap<string, SessionEnrichment>;
  /** False when cmux state could not be read; the UI must not claim sessions are closed. */
  readonly livenessReadable: boolean;
  /** False when the session index could not be read; models and the resume shelf go missing. */
  readonly indexReadable?: boolean;
  /** False when lifecycle state could not be read; every visible row then degrades to active. */
  readonly catalogueReadable?: boolean;
  /** Epoch milliseconds used for relative times. */
  readonly now: number;
  /** How many resumable sessions the active shelf may show. */
  readonly recentLimit?: number;
  /** How many rows a completed or archived history view may show. */
  readonly historyLimit?: number;
}

export type SidebarSection = "needs-you" | "working" | "ready" | "recent" | "other";

export interface SidebarModel {
  readonly id: string;
  /** Short display name, e.g. `Sol`, `Opus`, `Fable`. */
  readonly label: string;
  /** Which provider icon the UI should draw. */
  readonly provider: "anthropic" | "openai" | "unknown";
  readonly color: string;
}

/** What every row carries, whatever is behind it. */
interface SidebarRowShared {
  /** Stable identity for keys and actions: a canonical session id, or a workspace UUID. */
  readonly id: string;
  /** True when cmux has the workspace pinned, so the UI can lead with it. */
  readonly pinned: boolean;
  /** True when this is the workspace cmux currently has focused. */
  readonly focused: boolean;
  /** Middle line: what this row is. */
  readonly name: string;
  /** Top left: the project this row belongs to, stable across its worktrees. */
  readonly directory: string | null;
  readonly directoryPath: string | null;
  /** Where the UI can fetch the project's own icon, when it publishes one. */
  readonly faviconUrl: string | null;
  /** Bottom left: the git worktree, when the directory is inside one. */
  readonly worktree: string | null;
  /** Top right: cmux's own status pill, never synthesized by this module. */
  readonly status: CmuxClaudeStatus | null;
  /** Why the pill is absent, so a failed read is never represented as a published Ready state. */
  readonly statusAvailability: CmuxStatusAvailability;
  /** Bottom right: epoch milliseconds of the last recorded activity. */
  readonly lastActivityAt: number | null;
  readonly section: SidebarSection;
  /** Present only while the row occupies a cmux workspace. */
  readonly workspaceRef: string | null;
  readonly workspaceId: string | null;
  /**
   * The ⌘N that jumps to this row, or null when none does. Only ⌘1…9 exist and they count within
   * the focused window, so a row in a background window or past the ninth position has none.
   */
  readonly shortcut: number | null;
  /** Which cmux window holds the workspace, so the UI can group by it. */
  readonly windowRef: string | null;
  readonly windowId: string | null;
  /**
   * Unread cmux notifications for this row's workspace — cmux's own count, never derived from
   * status. Zero both when there are none and when the list could not be read; an invented
   * badge is worse than a missing one.
   */
  readonly unread: number;
}

/** A row backed by a Claude session, live or resumable. */
export interface SidebarSessionRow extends SidebarRowShared {
  readonly kind: "session";
  readonly sessionId: string;
  readonly lifecycle: SidebarLifecycle;
  /** Bottom right: the model behind the session. */
  readonly model: SidebarModel | null;
  /**
   * What this session was about, from catalogue enrichment. Null for sessions that have never
   * been enriched — the UI shows nothing rather than inventing a description.
   */
  readonly summary: SidebarSummary | null;
}

/**
 * A row backed only by a cmux workspace — no session, so no model and no lifecycle.
 *
 * These exist so every tab cmux can show is reachable from here. Lifecycle actions do not apply:
 * there is nothing to complete or archive, and the type says so rather than leaving a consumer to
 * discover it by calling `ccs finish` on a browser pane.
 */
export interface SidebarWorkspaceRow extends SidebarRowShared {
  readonly kind: "workspace";
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly windowId: string;
  readonly windowRef: string;
  readonly surfaceKinds: readonly string[];
}

export type SidebarRow = SidebarSessionRow | SidebarWorkspaceRow;

export interface SidebarSnapshot {
  readonly rows: readonly SidebarRow[];
  readonly livenessReadable: boolean;
  /** False when the index was unreadable, so the UI can say what is missing rather than imply it. */
  readonly indexReadable: boolean;
  /** False when lifecycle state was unreadable and visible rows were conservatively left active. */
  readonly catalogueReadable: boolean;
  readonly generatedAt: number;
}

const DEFAULT_RECENT_LIMIT = 8;
const DEFAULT_HISTORY_LIMIT = 50;

/** Collapse catalogue's non-terminal states into the sidebar's active lifecycle. */
export function sidebarLifecycleOf(lifecycle: Lifecycle): SidebarLifecycle {
  if (lifecycle === "archived") return "archived";
  if (lifecycle === "completed") return "completed";
  return "active";
}

/**
 * Which provider drew a model, and how to write its name in a GUI.
 *
 * The colour is deliberately absent: CCS already decides what colour each model family is, and
 * a second copy here would drift the moment either side changed. `familyOf` stays the one
 * authority; this table only adds what a terminal badge never needed — the provider whose logo
 * to draw, and a capitalised label.
 */
const MODEL_IDENTITIES: ReadonlyArray<{
  readonly prefix: string;
  readonly label: string;
  readonly provider: SidebarModel["provider"];
}> = [
  { prefix: "gpt-5.6-sol", label: "Sol", provider: "openai" },
  { prefix: "gpt-5.6-terra", label: "Terra", provider: "openai" },
  { prefix: "gpt-5.6-luna", label: "Luna", provider: "openai" },
  { prefix: "gpt-", label: "GPT", provider: "openai" },
  { prefix: "claude-fable", label: "Fable", provider: "anthropic" },
  { prefix: "claude-mythos", label: "Mythos", provider: "anthropic" },
  { prefix: "claude-opus", label: "Opus", provider: "anthropic" },
  { prefix: "claude-sonnet", label: "Sonnet", provider: "anthropic" },
  { prefix: "claude-haiku", label: "Haiku", provider: "anthropic" },
];

/** Resolve one model id to its short display identity. */
export function modelOf(modelId: string): SidebarModel {
  const color = familyOf(modelId).color;
  for (const identity of MODEL_IDENTITIES) {
    if (modelId.startsWith(identity.prefix)) {
      return { id: modelId, label: identity.label, provider: identity.provider, color };
    }
  }
  return { id: modelId, label: modelId, provider: "unknown", color };
}

/**
 * The model a row should show: the one that accounts for the most spend, else the first
 * observed model so an unpriced gateway session still identifies itself.
 */
function dominantModel(session: IndexedSessionInput): SidebarModel | null {
  let best: string | null = null;
  let bestCost = -1;
  for (const [modelId, cost] of Object.entries(session.costByModel)) {
    if (cost > bestCost) {
      bestCost = cost;
      best = modelId;
    }
  }
  const chosen = bestCost > 0 ? best : (session.models[0] ?? best);
  return chosen ? modelOf(chosen) : null;
}

/**
 * cmux prefixes a workspace title with its own activity glyph (a braille spinner while a turn
 * runs, an asterisk when one ends). The sidebar already shows that state as a status pill, so
 * the glyph would be the same fact twice — and it makes titles jitter as the spinner animates.
 */
const TITLE_ACTIVITY_GLYPHS = /^[⠀-⣿✱-❋·•\s]+/;

export function cleanSessionName(title: string): string {
  const cleaned = title.replace(TITLE_ACTIVITY_GLYPHS, "").trim();
  return cleaned.length > 0 ? cleaned : title.trim();
}

/** The final path segment, which is what identifies a directory at a glance. */
export function directoryLabel(path: string | null): string | null {
  if (!path) return null;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Which section a live session belongs in, read from cmux's own status label.
 *
 * cmux owns this vocabulary; we classify its words rather than inventing a parallel state
 * machine. A successful read with no published label lands in Ready. An unreadable command is
 * elevated to Needs you: that is an attention classification, not a fabricated cmux status, and
 * avoids silently demoting a session whose real pill may be Running or Needs input.
 */
export function sectionForStatus(
  status: CmuxClaudeStatus | null,
  availability: CmuxStatusAvailability = status ? "published" : "absent",
): SidebarSection {
  if (availability === "unreadable") return "needs-you";
  const label = status?.label?.toLowerCase() ?? "";
  if (!label) return "ready";
  if (label.includes("input") || label.includes("waiting") || label.includes("permission")) {
    return "needs-you";
  }
  if (label.includes("running") || label.includes("working") || label.includes("thinking")) {
    return "working";
  }
  return "ready";
}

/**
 * Build the sidebar's rows.
 *
 * Active live sessions keep cmux's ordering, while lifecycle history follows indexed recency.
 * Closed rows are emitted only after a readable liveness check, because otherwise a running
 * session could be represented as resumable.
 */
export function projectSidebar(input: ProjectionInput): SidebarSnapshot {
  const indexedById = new Map<string, IndexedSessionInput>();
  for (const session of input.indexed) {
    indexedById.set(session.sessionId, session);
    // A resumed session is addressed by its resume id, so index both without losing the
    // canonical row when the two ids collide across sessions.
    if (!indexedById.has(session.resumeId)) indexedById.set(session.resumeId, session);
  }

  const scope = input.scope ?? "active";
  const lifecycles = input.lifecycles ?? new Map<string, SidebarLifecycle>();
  const lifecycleFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): SidebarLifecycle =>
    lifecycles.get(sessionId)
      ?? (indexed ? lifecycles.get(indexed.sessionId) ?? lifecycles.get(indexed.resumeId) : undefined)
      ?? "active";
  const canonicalSessionIds = input.canonicalSessionIds ?? new Map<string, string>();
  const canonicalSessionIdFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): string =>
    canonicalSessionIds.get(sessionId)
      ?? (indexed
        ? canonicalSessionIds.get(indexed.sessionId) ?? canonicalSessionIds.get(indexed.resumeId)
        : undefined)
      ?? sessionId;

  const faviconDirectories = input.faviconDirectories ?? new Set<string>();
  const unreadByWorkspaceId = input.unreadByWorkspaceId ?? new Map<string, number>();
  const unreadFor = (workspaceId: string | null): number =>
    (workspaceId ? unreadByWorkspaceId.get(workspaceId) : 0) ?? 0;
  const summaries = input.summaries ?? new Map<string, SessionEnrichment>();
  const summaryFor = (
    sessionId: string,
    indexed: IndexedSessionInput | undefined,
  ): SidebarSummary | null => {
    const found = summaries.get(sessionId)
      ?? (indexed ? summaries.get(indexed.sessionId) ?? summaries.get(indexed.resumeId) : undefined);
    if (!found) return null;
    const now = indexed?.messageCount ?? null;
    const messagesSince = now !== null && found.atMessages !== null
      ? Math.max(0, now - found.atMessages)
      : null;
    return { ...found, messagesSince };
  };
  const faviconUrlFor = (cwd: string | null): string | null =>
    cwd && faviconDirectories.has(cwd) ? `/api/favicon?dir=${encodeURIComponent(cwd)}` : null;

  /**
   * The top line names the project, not the folder the session happens to sit in. Ten worktrees
   * of one repository are ten checkouts of the same project, and reading them as ten different
   * projects is what makes a worktree-heavy fleet illegible. Outside git, the folder is all we
   * can truthfully say.
   */
  const projectFor = (cwd: string | null): string | null =>
    (cwd ? input.checkouts.get(cwd)?.project : null) ?? directoryLabel(cwd);

  /** The second line answers "which checkout", so it appears only for a linked worktree. */
  const worktreeFor = (cwd: string | null): string | null =>
    (cwd ? input.checkouts.get(cwd)?.worktree : null) ?? null;

  const rowForLive = (
    live: LiveSessionInput,
    indexed: IndexedSessionInput | undefined,
  ): SidebarSessionRow => {
    const cwd = live.cwd ?? indexed?.cwd ?? null;
    const cmuxActivity = live.updatedAt === null ? null : live.updatedAt * 1000;
    return {
      kind: "session",
      id: canonicalSessionIdFor(live.sessionId, indexed),
      workspaceId: live.workspaceId,
      windowId: live.windowId,
      windowRef: live.windowRef,
      unread: unreadFor(live.workspaceId),
      shortcut: live.shortcut,
      summary: summaryFor(live.sessionId, indexed),
      sessionId: canonicalSessionIdFor(live.sessionId, indexed),
      lifecycle: lifecycleFor(live.sessionId, indexed),
      name: cleanSessionName(live.workspaceTitle ?? indexed?.title ?? "Untitled session"),
      directory: projectFor(cwd),
      directoryPath: cwd,
      faviconUrl: faviconUrlFor(cwd),
      worktree: worktreeFor(cwd),
      model: indexed ? dominantModel(indexed) : null,
      status: live.status,
      statusAvailability: live.statusAvailability,
      lastActivityAt: cmuxActivity ?? parseTimestamp(indexed?.lastTs ?? null),
      section: sectionForStatus(live.status, live.statusAvailability),
      workspaceRef: live.workspaceRef,
      pinned: live.pinned,
      focused: live.focused,
    };
  };

  const rowForIndexed = (
    session: IndexedSessionInput,
    knownLive: boolean,
  ): SidebarSessionRow => ({
    kind: "session",
    id: canonicalSessionIdFor(session.sessionId, session),
    workspaceId: null,
    windowId: null,
    windowRef: null,
    unread: 0,
    shortcut: null,
    summary: summaryFor(session.sessionId, session),
    sessionId: canonicalSessionIdFor(session.sessionId, session),
    lifecycle: lifecycleFor(session.sessionId, session),
    name: cleanSessionName(session.title),
    directory: projectFor(session.cwd),
    directoryPath: session.cwd,
    faviconUrl: faviconUrlFor(session.cwd),
    worktree: worktreeFor(session.cwd),
    model: dominantModel(session),
    status: null,
    statusAvailability: knownLive ? "absent" : "not-live",
    lastActivityAt: parseTimestamp(session.lastTs),
    section: knownLive ? "ready" : "recent",
    workspaceRef: null,
    pinned: false,
    focused: false,
  });

  /**
   * A workspace no session owns. Activity is left null rather than guessed: cmux records
   * timestamps against sessions, so a browser pane genuinely has no last-activity we can read,
   * and inventing one would sort it against sessions on a number that means nothing.
   */
  const rowForWorkspace = (workspace: LiveWorkspaceInput): SidebarWorkspaceRow => ({
    kind: "workspace",
    id: workspace.workspaceId,
    name: cleanSessionName(
      workspace.workspaceTitle ?? directoryLabel(workspace.cwd) ?? "Untitled tab",
    ),
    directory: projectFor(workspace.cwd),
    directoryPath: workspace.cwd,
    faviconUrl: faviconUrlFor(workspace.cwd),
    worktree: worktreeFor(workspace.cwd),
    status: null,
    statusAvailability: "absent",
    lastActivityAt: null,
    section: "other",
    workspaceId: workspace.workspaceId,
    workspaceRef: workspace.workspaceRef,
    windowId: workspace.windowId,
    windowRef: workspace.windowRef,
    unread: unreadFor(workspace.workspaceId),
    shortcut: workspace.shortcut,
    surfaceKinds: workspace.surfaceKinds,
    pinned: workspace.pinned,
    focused: workspace.focused,
  });

  const liveIds = new Set(input.liveSessionIds ?? []);
  const liveById = new Map<string, LiveSessionInput>();
  for (const live of input.live) {
    liveIds.add(live.sessionId);
    liveById.set(live.sessionId, live);
    const indexed = indexedById.get(live.sessionId);
    if (!indexed) continue;
    liveIds.add(indexed.sessionId);
    liveIds.add(indexed.resumeId);
    if (!liveById.has(indexed.sessionId)) liveById.set(indexed.sessionId, live);
    if (!liveById.has(indexed.resumeId)) liveById.set(indexed.resumeId, live);
  }

  const rows: SidebarRow[] = [];
  if (scope === "active") {
    for (const live of input.live) {
      const indexed = indexedById.get(live.sessionId);
      if (lifecycleFor(live.sessionId, indexed) !== "active") continue;
      rows.push(rowForLive(live, indexed));
    }

    // Sessionless workspaces are live tabs, so they belong to the active scope only — there is no
    // completed or archived state for a browser pane to be browsed under.
    for (const workspace of input.workspaces ?? []) rows.push(rowForWorkspace(workspace));

    // The shelf only makes sense when liveness is readable; otherwise a live session could be
    // presented as resumable and clicking it would spawn a duplicate.
    if (input.livenessReadable) {
      const limit = input.recentLimit ?? DEFAULT_RECENT_LIMIT;
      const seen = new Set<string>();
      let added = 0;
      for (const session of input.indexed) {
        if (added >= limit) break;
        if (lifecycleFor(session.sessionId, session) !== "active") continue;
        if (liveIds.has(session.sessionId) || liveIds.has(session.resumeId)) continue;
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        rows.push(rowForIndexed(session, false));
        added += 1;
      }
    }
  } else {
    const limit = input.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    type HistoryCandidate = {
      readonly row: SidebarRow;
      readonly timestamp: number | null;
      readonly order: number;
    };
    const liveCandidates: HistoryCandidate[] = [];
    const closedCandidates: HistoryCandidate[] = [];
    const seen = new Set<string>();
    const compareHistory = (left: HistoryCandidate, right: HistoryCandidate): number => {
      if (left.timestamp !== right.timestamp) {
        return (right.timestamp ?? Number.NEGATIVE_INFINITY)
          - (left.timestamp ?? Number.NEGATIVE_INFINITY);
      }
      return left.order - right.order;
    };

    // Terminal live sessions remain actionable even when their transcript has not reached the
    // index yet or falls outside the capped history query.
    for (const [order, live] of input.live.entries()) {
      const indexed = indexedById.get(live.sessionId);
      if (lifecycleFor(live.sessionId, indexed) !== scope) continue;
      const row = rowForLive(live, indexed);
      if (seen.has(row.sessionId)) continue;
      seen.add(row.sessionId);
      liveCandidates.push({ row, timestamp: row.lastActivityAt, order });
    }

    for (const [index, session] of input.indexed.entries()) {
      if (lifecycleFor(session.sessionId, session) !== scope) continue;
      const live = liveById.get(session.sessionId) ?? liveById.get(session.resumeId);
      const knownLive = live !== undefined
        || liveIds.has(session.sessionId)
        || liveIds.has(session.resumeId);
      const row = live ? rowForLive(live, session) : rowForIndexed(session, knownLive);
      if (seen.has(row.sessionId)) continue;
      // Without a readable liveness snapshot, every unobserved indexed row might still be running.
      if (!input.livenessReadable && !knownLive) continue;
      seen.add(row.sessionId);
      const candidate = {
        row,
        timestamp: row.lastActivityAt,
        order: input.live.length + index,
      };
      if (knownLive) liveCandidates.push(candidate);
      else closedCandidates.push(candidate);
    }

    liveCandidates.sort(compareHistory);
    closedCandidates.sort(compareHistory);
    const selected = liveCandidates.slice(0, limit);
    selected.push(...closedCandidates.slice(0, Math.max(0, limit - selected.length)));
    selected.sort(compareHistory);
    rows.push(...selected.map((candidate) => candidate.row));
  }

  return {
    rows,
    livenessReadable: input.livenessReadable,
    indexReadable: input.indexReadable ?? true,
    catalogueReadable: input.catalogueReadable ?? true,
    generatedAt: input.now,
  };
}

/** Directories the caller should resolve worktrees for, deduplicated. */
export function directoriesToResolve(
  live: readonly LiveSessionInput[],
  indexed: readonly IndexedSessionInput[],
  recentLimit = DEFAULT_RECENT_LIMIT,
): string[] {
  const directories = new Set<string>();
  for (const session of live) {
    if (session.cwd) directories.add(session.cwd);
  }
  let considered = 0;
  for (const session of indexed) {
    if (considered >= recentLimit * 4) break;
    considered += 1;
    if (session.cwd) directories.add(session.cwd);
  }
  return [...directories];
}
