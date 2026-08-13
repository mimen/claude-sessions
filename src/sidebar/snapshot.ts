/**
 * The sidebar's one interface to the rest of CCS.
 *
 * Callers can read a scoped picture, open a row, and change that row's lifecycle — nothing else.
 * Behind them sit the cmux bridge, the hook store, cmux's status pills, git worktrees, the
 * session index, and managed resume. In particular, "focus it if it is live, resume it through
 * CCS if it is not" is decided here rather than by every caller, because getting that wrong
 * spawns a duplicate of a running session.
 */
import { statSync } from "node:fs";
import type { DestroyEnvironment } from "../catalogue/destroy.ts";
// ADR-0068 keeps database handles out of the request layer: this module may not open the
// catalogue, so the destroy and incognito writes go through the command layer that owns them.
import {
  destroySessionTree,
  markSessionIncognito,
  previewDestroy,
  type CatalogueDestroyOptions,
} from "../catalogue/destroy-command.ts";
import {
  declineExistingSessionRecommendation,
  setExistingSessionLifecycle,
  type CatalogueCommandOptions,
} from "../catalogue/commands.ts";
import { DB_PATH, CATALOGUE_PATH, CATEGORY_REGISTRY_PATH, ensureDataDir } from "../paths.ts";
import { createLiveBridgeReader } from "../cmux/live.ts";
import type { Bridge } from "../cmux/bridge.ts";
import {
  closeSessionWorkspaceCandidates,
  type CloseSessionWorkspaceDependencies,
  type CloseSessionWorkspaceOutcome as PrimitiveCloseOutcome,
} from "../cmux/close-current.ts";
import {
  finishSession,
  type FinishLifecycle,
  type FinishSessionDependencies,
  type FinishSessionOutcome,
} from "../cmux/finish-current.ts";
import { launchImmediateEnrichment } from "../cmux/launch-enrichment.ts";
import {
  createSidebarResumeAction,
  type SidebarResumeAction,
} from "../resume/sidebar-action.ts";
import { loadLaunchers } from "../resume/launchers.ts";
import {
  bunAsyncProcessAdapter,
  type AsyncProcessAdapter,
} from "../process/async.ts";
import { log } from "../logger.ts";
import { err, ok, type Result } from "../result.ts";
import { readIndexReadOnly } from "./index-read.ts";
import { createSidebarReadCache, type SidebarReadCache } from "./read-cache.ts";
import {
  readCatalogueReadOnly,
  type CatalogueReadOutcome,
  type CatalogueSnapshotFacts,
} from "./catalogue-read.ts";
import { exactMessageCount } from "./tail-count.ts";
import {
  createCachedStatusReader,
  readClaudeStatuses,
  statusFromAgentLifecycle,
  type CachedStatusReader,
  type CmuxStatusRead,
} from "./status.ts";
import {
  createCachedNotificationReader,
  type CachedNotificationReader,
} from "./notifications.ts";
import {
  createCachedWorkspaceStateReader,
  type CachedWorkspaceStateReader,
} from "./workspace-state.ts";
import {
  createDirectoryFactsCache,
  type DirectoryFactsResult,
} from "./directory-facts.ts";
import {
  lifecycleForView,
  directoriesToResolve,
  projectSidebar,
  sidebarLifecycleOf,
  type IndexedSessionInput,
  type LiveSessionInput,
  type LiveWorkspaceInput,
  type SidebarLifecycle,
  type SidebarScope,
  type SidebarSnapshot,
  type SidebarView,
  type SidebarMembership,
} from "./projection.ts";
import type { StoredEnrichment } from "../catalogue/enrichment.ts";
import { createSessionActionCoordinator } from "./session-action-coordinator.ts";
import { readSidebarCategoryProjection } from "./category-projection.ts";
import type { OpenSessionOutcome } from "./session-action-coordinator.ts";
import { paintResumedWorkspace } from "./cosmetic-paint.ts";
import { createSnapshotLivenessReader } from "./liveness-cache.ts";
export type { OpenSessionOutcome } from "./session-action-coordinator.ts";

/** How many indexed sessions are considered before the resume shelf is filled. */
const INDEX_SCAN_LIMIT = 200;
const RECENT_LIMIT = 8;
const HISTORY_LIMIT = 50;
/** Covers the normal gap between workspace spawn and cmux's SessionStart surface binding. */
const RECENTLY_RESUMED_MS = 15_000;
/**
 * How stale an authoritative status sweep may get before another is kicked off. Long enough that
 * a four-second poll rarely triggers one, short enough that a corrected label lands within a beat.
 */
const STATUS_TTL_MS = 2_500;
/** Branch, PR, and cwd move far more slowly than a status pill, so they are cached longer. */
const WORKSPACE_STATE_TTL_MS = 10_000;
/** One cheap command covers every workspace, so this can stay close to the poll interval. */
const NOTIFICATION_TTL_MS = 2_000;
/** The live tree changes quickly, but a subprocess per one-second poll is unnecessary. */
const SNAPSHOT_LIVENESS_TTL_MS = 2_500;

export type SessionLifecycleAction = "complete" | "save" | "uncomplete" | "unsave";

export type SessionLifecycleOutcome =
  | {
    readonly status: "ok";
    readonly lifecycle: SidebarLifecycle;
    /** Set when the catalogue write landed but the workspace would not close. */
    readonly closeFailed?: string;
  }
  | { readonly status: "not-found" }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

/** Read the current picture and act on one row. Nothing else is exposed to callers. */
export type CloseWorkspaceOutcome =
  | { readonly status: "closed" }
  /** Nothing to close: the session has no live workspace. */
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "timeout" }
  /**
   * `reason` is for the log and may name paths; `refusal` is the safe half, drawn from CCS's own
   * closed set of refusals, and is the only part a client is told.
   */
  | { readonly status: "failed"; readonly reason: string; readonly refusal?: string };

export type FocusWorkspaceOutcome =
  | { readonly status: "focused" }
  /** The workspace is no longer in the live tree, so there is nothing to focus. */
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string };

export type PinWorkspaceOutcome =
  | { readonly status: "pinned"; readonly pinned: boolean }
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string };

export type IncognitoOutcome =
  | { readonly status: "ok"; readonly incognito: boolean }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

/** The figures the confirmation dialog needs, and nothing the reader would have to interpret. */
export type DestroyPreflightOutcome =
  | {
    readonly status: "ok";
    /** The named session plus every descendant that would go with it. */
    readonly sessionCount: number;
    /** Files and directories that would be removed. */
    readonly pathCount: number;
    /** Sessions that would be closed before anything is deleted. */
    readonly liveCount: number;
    /** Identity keys left behind, since destroy never removes an identity. */
    readonly survivingIdentities: readonly string[];
  }
  | { readonly status: "not-found" }
  | { readonly status: "failed"; readonly reason: string };

export type DestroyOutcomeReport =
  | {
    readonly status: "destroyed";
    readonly sessionIds: readonly string[];
    readonly filesRemoved: number;
  }
  /** A live workspace would not close, so nothing at all was deleted. */
  | { readonly status: "aborted"; readonly reason: string }
  | { readonly status: "not-found" }
  | { readonly status: "failed"; readonly reason: string };

/** Declining touches one column and nothing else, so there is little that can go wrong loudly. */
export type DeclineOutcome =
  | { readonly status: "ok" }
  | { readonly status: "not-found" }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

export interface SidebarSource {
  /**
   * @param view Which list to build: a lifecycle, or `triage` for the active list filtered to
   *   rows whose verdict still contradicts where they sit.
   * @param rowLimit How many rows the caller has room for; it grows as the client scrolls.
   */
  /**
   * @param include Extra lifecycles to return rows for, beyond the view's own. Sections the
   *   client has collapsed are simply not requested, so a shelved section costs nothing to
   *   project and its header still shows a count from `lifecycleCounts`.
   */
  snapshot(
    view?: SidebarView,
    rowLimit?: number,
    include?: readonly SidebarLifecycle[],
    /**
     * Receives this call's phase timings before the promise settles.
     *
     * Per call rather than a shared callback on the source: the caller that wants to log a slow
     * request needs the phases belonging to *that* request, and reading a latest-wins slot after
     * an await can attribute another concurrent snapshot's numbers to it.
     */
    observe?: (measurement: SidebarSnapshotMeasurement) => void,
  ): Promise<SidebarSnapshot>;
  /** Start a fresh snapshot-only liveness read without delaying the current response. */
  refreshSnapshotLiveness?(): void;
  /** Await a liveness read newer than this call, for a caller that just changed the world. */
  refreshSnapshotLivenessNow?(): Promise<void>;
  /** Record that the reader refused a verdict, so the same one stops being offered. */
  declineSuggestion(sessionId: string, verb: string): Promise<DeclineOutcome>;
  open(sessionId: string): Promise<OpenSessionOutcome>;
  setLifecycle(
    sessionId: string,
    action: SessionLifecycleAction,
  ): Promise<SessionLifecycleOutcome>;
  /**
   * Complete or archive, then retire the workspace — the whole gesture the `ccs` verbs perform.
   * Reversing (`uncomplete`, `unarchive`) only writes the catalogue; there is nothing to close.
   */
  retire(
    sessionId: string,
    action: SessionLifecycleAction,
  ): Promise<SessionLifecycleOutcome>;
  /** Close the session's cmux workspace. Presentation only — the session itself survives. */
  closeWorkspace(sessionId: string): Promise<CloseWorkspaceOutcome>;
  /**
   * Focus a workspace by its own UUID, for rows that have no session to resolve one from.
   *
   * Verified against the live tree first: focusing an id the snapshot no longer contains would
   * act on whatever cmux has since put there, and a stale click must fail rather than guess.
   */
  focusWorkspace(workspaceId: string): Promise<FocusWorkspaceOutcome>;
  /**
   * Close a workspace that no session owns.
   *
   * Refuses any workspace holding a bound session: those must go through the session close path,
   * which carries the primitive's own proofs. Without that refusal this would be a way to close a
   * running agent's workspace while skipping every check that exists to prevent exactly that.
   */
  closeLooseWorkspace(workspaceId: string): Promise<CloseWorkspaceOutcome>;
  /** Pin or unpin a workspace. Pins are cmux's own, so cmux stays the single source of truth. */
  setPinned(workspaceId: string, pinned: boolean): Promise<PinWorkspaceOutcome>;
  /** Mark or unmark a session incognito. Marking also clears any stored enrichment. */
  setIncognito(sessionId: string, incognito: boolean): Promise<IncognitoOutcome>;
  /**
   * What destroying this session would remove. Reads only; deletes nothing.
   *
   * Its own call rather than a flag on `destroySession` because the confirmation dialog needs the
   * figures before the reader decides, and an endpoint that sometimes deletes is one typo in a
   * client away from deleting when it was asked to describe.
   */
  destroyPreflight(sessionId: string): Promise<DestroyPreflightOutcome>;
  /** Irreversibly erase a session and its descendants. Closes live workspaces first, or aborts. */
  destroySession(sessionId: string): Promise<DestroyOutcomeReport>;
  /**
   * The icon file for a directory the latest snapshot published, or null for anything else.
   * Callers pass a directory, never a path to read, so this is the only way a file reaches the
   * browser and it can only ever be an icon this module already found.
   */
  faviconFor(directory: string): string | null;
}

/**
 * The ⌘N that reaches a workspace, or null.
 *
 * cmux counts positions within the FOCUSED window, so a workspace sitting in a background window
 * has no reachable shortcut even though it has an index — showing its number there would send you
 * to whatever occupies that slot in the window you are actually looking at.
 */
function shortcutFor(
  workspaceIndex: number | null,
  windowId: string,
  activeWindowId: string | null,
): number | null {
  if (workspaceIndex === null || activeWindowId === null) return null;
  if (windowId !== activeWindowId) return null;
  return workspaceIndex < 9 ? workspaceIndex + 1 : null;
}

function liveSessionsFrom(
  bridge: Bridge,
  pinnedWorkspaces: ReadonlySet<string>,
  statuses: ReadonlyMap<string, CmuxStatusRead>,
): LiveSessionInput[] {
  const sessions: LiveSessionInput[] = [];
  const claimedWorkspaces = new Set<string>();

  for (const surface of bridge.surfaces) {
    const info = bridge.surfaceInfo(surface.surfaceId);
    if (!info) continue;
    // A workspace with several Claude surfaces is one row: the tab, its title, and its status
    // all belong to the primary surface, so a secondary pane must not duplicate the row.
    if (claimedWorkspaces.has(surface.workspaceId)) continue;
    claimedWorkspaces.add(surface.workspaceId);

    let statusRead = statuses.get(surface.workspaceId) ?? { state: "unreadable" as const };
    if (statusRead.state !== "published") {
      const derived = statusFromAgentLifecycle(info.agentLifecycle);
      if (derived) statusRead = { state: "derived", status: derived };
    }
    sessions.push({
      sessionId: info.sessionId,
      workspaceId: surface.workspaceId,
      workspaceRef: surface.workspaceRef,
      windowId: surface.windowId,
      windowRef: surface.windowRef,
      workspaceTitle: surface.workspaceTitle,
      pinned: pinnedWorkspaces.has(surface.workspaceId),
      focused: surface.workspaceActive === true,
      shortcut: shortcutFor(surface.workspaceIndex ?? null, surface.windowId, bridge.activeWindowId),
      cwd: info.cwd,
      status: statusRead.state === "published" || statusRead.state === "derived"
        ? statusRead.status
        : null,
      statusAvailability: statusRead.state,
      updatedAt: info.updatedAt ?? null,
    });
  }
  return sessions;
}

/**
 * Live workspaces no Claude session owns: plain shells, browser splits, markdown panels.
 *
 * cmux's own rail lists these, so replacing it means reaching them from here too. A workspace
 * qualifies only when NONE of its surfaces has a bound session — a workspace whose agent sits
 * beside a browser pane is already a session row and must not appear twice.
 *
 * The working directory is left null. The bridge carries cwd only for bound sessions, and the
 * per-workspace read that knows a sessionless workspace's directory is a separate cmux call; a
 * guess derived from a shell's title would be wrong the moment anything retitled the tab.
 *
 * Scoped to the focused window. These rows are navigation, and navigation is window-local: a
 * shell sitting in a background window is noise next to the tabs actually on screen. Sessions are
 * deliberately NOT scoped this way — hiding one that needs input would break the queue's promise.
 * An unknown active window shows everything, so a tab is never hidden on a guess.
 */
function liveWorkspacesFrom(
  bridge: Bridge,
  pinnedWorkspaces: ReadonlySet<string>,
): LiveWorkspaceInput[] {
  const workspaces: LiveWorkspaceInput[] = [];
  const activeWindowId = bridge.activeWindowId;
  for (const workspaceId of bridge.workspaceIds()) {
    const surfaces = bridge.surfacesInWorkspace(workspaceId);
    if (surfaces.some((surface) => bridge.surfaceInfo(surface.surfaceId) !== null)) continue;
    const first = surfaces[0];
    if (!first) continue;
    if (activeWindowId !== null && first.windowId !== activeWindowId) continue;
    workspaces.push({
      workspaceId,
      workspaceRef: first.workspaceRef,
      workspaceTitle: first.workspaceTitle,
      windowId: first.windowId,
      windowRef: first.windowRef,
      pinned: pinnedWorkspaces.has(workspaceId),
      focused: first.workspaceActive === true,
      shortcut: shortcutFor(first.workspaceIndex ?? null, first.windowId, activeWindowId),
      cwd: null,
      surfaceKinds: surfaces.map((surface) => surface.surfaceType ?? "unknown"),
    });
  }
  return workspaces;
}

/**
 * Workspaces cmux has pinned. The bridge flattens surfaces and drops the workspace's own pin, so
 * it is read back off the raw tree; an unreadable tree simply means nothing is pinned.
 */
function pinnedWorkspacesFrom(bridge: Bridge): Set<string> {
  const pinned = new Set<string>();
  for (const surface of bridge.surfaces) {
    if (surface.workspacePinned) pinned.add(surface.workspaceId);
  }
  return pinned;
}

/** Every bound session remains live even when another surface owns its workspace's one visible row. */
function allLiveSessionIdsFrom(bridge: Bridge): Set<string> {
  const sessionIds = new Set<string>();
  for (const surface of bridge.surfaces) {
    const info = bridge.surfaceInfo(surface.surfaceId);
    if (info) sessionIds.add(info.sessionId);
  }
  return sessionIds;
}

type CatalogueLifecycleState = CatalogueSnapshotFacts;

/**
 * When the transcript was last written, or null when it cannot be read.
 *
 * Null rather than a throw or a zero: a missing transcript means the drift question simply
 * cannot be answered, and answering it wrongly is what this whole path exists to prevent.
 */
function transcriptMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function lifecycleForIndexedSession(
  session: IndexedSessionInput,
  lifecycles: ReadonlyMap<string, SidebarLifecycle>,
): SidebarLifecycle {
  return lifecycles.get(session.sessionId) ?? lifecycles.get(session.resumeId) ?? "active";
}

interface DirectoryFactsReader {
  lookup(directories: readonly string[]): Promise<DirectoryFactsResult>;
}

export interface SidebarSnapshotMeasurement {
  readonly view: SidebarView;
  readonly rowCount: number;
  readonly totalMs: number;
  readonly phases: Readonly<{
    bridgeMs: number;
    catalogueMs: number;
    indexMs: number;
    /** The `cmux list-status` sweep alone: one subprocess per workspace, eight at a time. */
    statusMs: number;
    /** Per-workspace state for workspaces with no session, read only when some exist. */
    workspaceStateMs: number;
    /**
     * Exact message counts for rows carrying an enrichment.
     *
     * One `statSync` per such row, so the cost scales with the list and blocks the loop while
     * it runs — the `Promise.all` around it parallelises nothing.
     */
    messageCountMs: number;
    /** Checkout and favicon facts for every directory the visible rows name. */
    directoryFactsMs: number;
    notificationsMs: number;
    projectionMs: number;
  }>;
  readonly livenessReadable: boolean;
  readonly catalogueReadable: boolean;
  readonly indexReadable: boolean;
}

export interface SidebarSourceOptions {
  /** Override the cmux binary used by status, focus, and resume commands. */
  readonly cmuxBin?: string;
  readonly now?: () => number;
  readonly recentlyResumedMs?: number;
  /** Narrow I/O seams keep source tests away from the real cmux process and session spawner. */
  readonly readBridge?: () => Promise<Bridge>;
  /** Test seam for the snapshot-only stale-while-revalidate window. */
  readonly snapshotLivenessTtlMs?: number;
  readonly readStatuses?: typeof readClaudeStatuses;
  /** Test seam: lets a test observe which rows the exact-count pass decided to stat. */
  readonly readExactMessageCount?: typeof exactMessageCount;
  readonly statusReader?: CachedStatusReader;
  readonly workspaceStateReader?: CachedWorkspaceStateReader;
  readonly notificationReader?: CachedNotificationReader;
  readonly processAdapter?: AsyncProcessAdapter;
  /** Invoked only after the CCS primitive authorizes a stable workspace UUID twice. */
  readonly closeCmuxWorkspace?: (
    workspaceId: string,
    windowRef: string,
    cmuxBin: string,
  ) => boolean | Promise<boolean>;
  readonly closeSessionWorkspaces?: typeof closeSessionWorkspaceCandidates;
  readonly finishSession?: typeof finishSession;
  readonly launchEnrichment?: FinishSessionDependencies["launchEnrichment"];
  readonly loadLaunchers?: typeof loadLaunchers;
  /** Managed resume owns its database handles outside the sidebar request/snapshot layer. */
  readonly resumeAction?: SidebarResumeAction;
  readonly logger?: Pick<typeof log, "warn">;
  readonly paintWorkspace?: typeof paintResumedWorkspace;
  readonly deferActionTask?: (task: () => void) => void;
  readonly indexPath?: string;
  readonly cataloguePath?: string;
  /** Test seam for destroy: a fake store, a fake cmux, and no real files to unlink. */
  readonly destroyEnvironment?: () => DestroyEnvironment;
  readonly categoryRegistryPath?: string;
  readonly readCategories?: typeof readSidebarCategoryProjection;
  readonly lifecycleCommand?: typeof setExistingSessionLifecycle;
  readonly declineCommand?: typeof declineExistingSessionRecommendation;
  readonly ensureDataDir?: typeof ensureDataDir;
  readonly readCatalogue?: typeof readCatalogueReadOnly;
  readonly readIndex?: typeof readIndexReadOnly;
  readonly readCache?: SidebarReadCache;
  readonly indexedSessions?: () => IndexedSessionInput[];
  readonly directoryFacts?: DirectoryFactsReader;
  /** Structured timing seam for benchmarks and slow-request diagnostics. */
  readonly observeSnapshot?: (measurement: SidebarSnapshotMeasurement) => void;
}

/** The production source, reading live cmux state and the local session index. */
export function createSidebarSource(options: SidebarSourceOptions = {}): SidebarSource {
  const cmuxBin = options.cmuxBin ?? "cmux";
  const now = options.now ?? (() => Date.now());
  const indexPath = options.indexPath ?? DB_PATH();
  const cataloguePath = options.cataloguePath ?? CATALOGUE_PATH();
  const destroyOptions = (): CatalogueDestroyOptions => ({
    cataloguePath,
    indexPath,
    now: () => new Date(now()),
    ensureDataDir: ensureDataDirectory,
    ...(options.destroyEnvironment === undefined
      ? {}
      : { environment: options.destroyEnvironment() }),
  });

  const categoryRegistryPath = options.categoryRegistryPath ?? CATEGORY_REGISTRY_PATH();
  const readCategories = options.readCategories ?? readSidebarCategoryProjection;
  const recentlyResumedMs = options.recentlyResumedMs ?? RECENTLY_RESUMED_MS;
  const readBridge = options.readBridge ?? createLiveBridgeReader({ cmuxBin });
  const snapshotLiveness = createSnapshotLivenessReader({
    ttlMs: options.snapshotLivenessTtlMs ?? SNAPSHOT_LIVENESS_TTL_MS,
    readBridge,
    now,
  });
  const readStatuses = options.readStatuses ?? readClaudeStatuses;
  const readExactMessageCount = options.readExactMessageCount ?? exactMessageCount;
  // Requests read this cache rather than spawning a subprocess per workspace.
  const statusReader: CachedStatusReader = options.statusReader
    ?? createCachedStatusReader(cmuxBin, STATUS_TTL_MS, now, readStatuses);
  const workspaceStateReader: CachedWorkspaceStateReader = options.workspaceStateReader
    ?? createCachedWorkspaceStateReader(cmuxBin, WORKSPACE_STATE_TTL_MS, now);
  const notificationReader: CachedNotificationReader = options.notificationReader
    ?? createCachedNotificationReader(cmuxBin, NOTIFICATION_TTL_MS, now);
  const processAdapter = options.processAdapter ?? bunAsyncProcessAdapter;
  const closeCmux = options.closeCmuxWorkspace ?? (async (workspaceId: string) =>
    (await processAdapter.run(
      cmuxBin,
      ["close-workspace", "--workspace", workspaceId],
      { timeoutMs: 5_000 },
    )).ok);
  const closeSessionWorkspaces = options.closeSessionWorkspaces ?? closeSessionWorkspaceCandidates;
  const runFinishSession = options.finishSession ?? finishSession;
  const launchEnrichment = options.launchEnrichment ?? launchImmediateEnrichment;
  const launcherLoader = options.loadLaunchers ?? loadLaunchers;
  const resumeAction = options.resumeAction ?? createSidebarResumeAction({
    processAdapter,
    indexPath,
    cataloguePath,
    logger: options.logger,
  });
  const ensureDataDirectory = options.ensureDataDir ?? ensureDataDir;
  const readCache = options.readCache
    ?? (options.readCatalogue === undefined && options.readIndex === undefined
      ? createSidebarReadCache(cataloguePath, indexPath)
      : null);
  const lifecycleCommand = options.lifecycleCommand ?? setExistingSessionLifecycle;
  const declineCommand = options.declineCommand ?? declineExistingSessionRecommendation;
  const catalogueCommandOptions: CatalogueCommandOptions = {
    cataloguePath,
    now: () => new Date(now()),
    ensureDataDir: ensureDataDirectory,
    logger: options.logger,
  };
  const readCatalogue = options.readCatalogue ?? readCatalogueReadOnly;
  const readIndex = options.readIndex ?? readIndexReadOnly;
  const readIndexedSessionsOverride = options.indexedSessions;
  const observeSnapshot = options.observeSnapshot;
  // Only directories the latest snapshot published can serve an icon; the map is replaced on
  // each snapshot so a directory that disappears stops being servable.
  let favicons = new Map<string, string>();
  const directoryFacts = options.directoryFacts ?? createDirectoryFactsCache(now);

  /**
   * The index is a convenience here, not a dependency.
   *
   * It supplies model identity and resumable rows; cmux alone already supplies the live work
   * queue. Another checkout can migrate the shared index ahead of this build, so an unreadable
   * index degrades row detail rather than blanking the active queue.
   */
  function readIndexedSessionsSafely(
    limit: number,
    sessionIds?: readonly string[],
  ): {
    readonly sessions: IndexedSessionInput[];
    readonly readable: boolean;
  } {
    try {
      const sessions = readIndexedSessionsOverride
        ? readIndexedSessionsOverride()
        : readCache
          ? readCache.readIndex({ limit, sessionIds })
          : readIndex(indexPath, { limit, sessionIds });
      if (sessionIds === undefined || !readIndexedSessionsOverride) {
        return { sessions: sessions.slice(0, limit), readable: true };
      }
      const requested = new Set(sessionIds);
      return {
        sessions: sessions.filter((session) =>
          requested.has(session.sessionId) || requested.has(session.resumeId)).slice(0, limit),
        readable: true,
      };
    } catch (error) {
      log.warn("sidebar could not read the session index; live rows only", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { sessions: [], readable: false };
    }
  }

  function readCatalogueLifecyclesSafely(): CatalogueLifecycleState & {
    readonly readable: boolean;
  } {
    const outcome: CatalogueReadOutcome = readCache
      ? readCache.readCatalogue()
      : readCatalogue(cataloguePath);
    if (outcome.status === "ok") return { ...outcome.facts, readable: true };

    const reason = outcome.status === "missing"
      ? "catalogue file is missing"
      : outcome.status === "unsupported-schema"
      ? `unsupported schema (${outcome.missing.join(", ")})`
      : outcome.error.message;
    log.warn("sidebar could not read the session catalogue; lifecycle degraded to active", {
      error: reason,
      status: outcome.status,
    });
    return {
      lifecycles: new Map(),
      catalogueLifecycles: new Map(),
      canonicalSessionIds: new Map(),
      preferredTitles: new Map<string, string>(),
      memberships: new Map<string, SidebarMembership>(),
      // Nothing is known to be auxiliary when the catalogue is unreadable, so nothing is hidden.
      auxiliary: new Set<string>(),
      // Incognito degrades the same way, and cannot do better: the catalogue is the only record of
      // which sessions are marked, so an unreadable one leaves the sidebar with nothing to filter
      // on. This is a broken-machine state, not a routine one -- the warning above is the signal.
      incognito: new Set<string>(),
      summaries: new Map<string, StoredEnrichment>(),
      sessionIds: new Map<SidebarLifecycle, readonly string[]>([
        ["active", []],
        ["completed", []],
        ["saved", []],
      ]),
      readable: false,
    };
  }

  function updateLifecycle(
    sessionId: string,
    action: SessionLifecycleAction,
  ): SessionLifecycleOutcome {
    const outcome = lifecycleCommand(sessionId, action, catalogueCommandOptions);
    if (outcome.status === "not-found") return outcome;
    if (outcome.status === "catalogue-unreadable") return outcome;
    return { status: "ok", lifecycle: sidebarLifecycleOf(outcome.value) };
  }

  function closeCandidateIds(sessionId: string): readonly string[] {
    const index = readIndexedSessionsSafely(1, [sessionId]);
    const row = index.sessions[0];
    return [...new Set([sessionId, row?.sessionId, row?.resumeId].filter(
      (candidate): candidate is string => candidate !== undefined,
    ))];
  }

  function primitiveCloseDependencies(): CloseSessionWorkspaceDependencies {
    return {
      bridge: readBridge,
      close: async (workspaceId, location) => ({
        ok: await closeCmux(workspaceId, location.windowRef, cmuxBin),
      }),
    };
  }

  function closeThroughPrimitive(
    sessionId: string,
    mutate: boolean,
  ): Promise<PrimitiveCloseOutcome> {
    return closeSessionWorkspaces(
      closeCandidateIds(sessionId),
      mutate,
      primitiveCloseDependencies(),
    );
  }

  function closeFailureReason(outcome: PrimitiveCloseOutcome): string {
    switch (outcome.status) {
      case "authorized":
        return "the workspace close was only authorized, not executed";
      case "refused":
        return `ccs refused to close the workspace (${outcome.reason})`;
      case "close-failed":
        return "cmux refused to close the workspace after CCS authorized it";
      case "closed":
        return "";
    }
  }

  const actionCoordinator = createSessionActionCoordinator({
    cmuxBin,
    now,
    recentlyResumedMs,
    readBridge,
    lookupIndexedSession(sessionId) {
      const index = readIndexedSessionsSafely(1, [sessionId]);
      const row = index.sessions[0];
      if (row) return { status: "found", row };
      return index.readable
        ? { status: "absent" }
        : { status: "unreadable", reason: "session index read failed" };
    },
    loadLaunchers: launcherLoader,
    resumeSession: resumeAction,
    processAdapter,
    paintWorkspace: options.paintWorkspace ?? paintResumedWorkspace,
    defer: options.deferActionTask,
  });

  return {
    /**
     * @param rowLimit How many rows the caller has room for. Absent means the default window;
     *   the client raises it as you scroll, which is what makes the list unbounded. The index
     *   scan is widened to match, since a limit the scan cannot feed is not a limit at all.
     */
    async snapshot(
      view: SidebarView = "active",
      rowLimit?: number,
      include: readonly SidebarLifecycle[] = [],
      observe?: (measurement: SidebarSnapshotMeasurement) => void,
    ): Promise<SidebarSnapshot> {
      const snapshotStartedAt = performance.now();
      let phaseStartedAt = snapshotStartedAt;
      let indexMs = 0;
      const scope = lifecycleForView(view);
      const triageOnly = view === "triage";
      const incognitoOnly = view === "incognito";
      const bridge = await snapshotLiveness.read();
      const bridgeMs = performance.now() - phaseStartedAt;
      phaseStartedAt = performance.now();
      const catalogue = readCatalogueLifecyclesSafely();
      const catalogueMs = performance.now() - phaseStartedAt;
      // Which lifecycles this response carries rows for: the view's own, plus any section the
      // client has expanded. A collapsed section is simply not asked for, so shelving one costs
      // nothing to project while its header keeps a count from `lifecycleCounts`.
      const lifecycles: readonly SidebarLifecycle[] = [
        scope,
        ...include.filter((lifecycle) => lifecycle !== scope),
      ];
      const explicitIds = lifecycles
        .filter((lifecycle) => lifecycle !== "active")
        .flatMap((lifecycle) => catalogue.sessionIds.get(lifecycle) ?? []);
      // Triage discards most of what it projects, so a window sized for the visible rows would
      // come back nearly empty. Widened here rather than by the client, which cannot know the
      // hit rate.
      const triageFactor = triageOnly ? 6 : 1;
      const recentLimit = (rowLimit ?? RECENT_LIMIT) * triageFactor;
      const historyLimit = (rowLimit ?? HISTORY_LIMIT) * triageFactor;
      // The scope's own read, unchanged: a recency-ordered scan for the active view, an id set
      // for the finished ones. Its readability is the answer for the whole snapshot, so it always
      // runs -- skipping it when an id set happened to be empty reported an unreadable index as
      // readable.
      // Live rows come from cmux, not the index, so the active scan has to cover the shelf plus
      // the live sessions it must skip over; a flat multiple is enough and stays cheap.
      const primaryScan = scope === "active"
        ? Math.max(INDEX_SCAN_LIMIT, recentLimit * 4)
        : historyLimit;
      phaseStartedAt = performance.now();
      const primaryIndex = readIndexedSessionsSafely(
        primaryScan,
        scope === "active" ? undefined : catalogue.sessionIds.get(scope) ?? [],
      );
      indexMs += performance.now() - phaseStartedAt;
      // A scan that came back short has reached the end of the index; one that filled its window
      // has not, whatever survives filtering afterwards. This is the only place that distinction
      // is observable, so it travels to the client rather than being guessed there.
      const hasMoreRows = primaryIndex.sessions.length >= primaryScan;
      // A second, purely additive read for sections the client has expanded. They are addressed by
      // id because finished sessions are old enough to fall outside a recency-ordered scan, so one
      // combined query could not serve both halves.
      const extraIds = lifecycles
        .filter((lifecycle) => lifecycle !== scope)
        .flatMap((lifecycle) => catalogue.sessionIds.get(lifecycle) ?? []);
      phaseStartedAt = performance.now();
      const extraIndex = extraIds.length > 0
        ? readIndexedSessionsSafely(historyLimit, extraIds)
        : { sessions: [], readable: primaryIndex.readable };
      indexMs += performance.now() - phaseStartedAt;
      const seenIndexIds = new Set(primaryIndex.sessions.map((session) => session.sessionId));
      const index = {
        sessions: [
          ...primaryIndex.sessions,
          ...extraIndex.sessions.filter((session) => !seenIndexIds.has(session.sessionId)),
        ],
        readable: primaryIndex.readable && extraIndex.readable,
      };

      // Delegated seats never reach the shelf or the history scopes; a live one still shows,
      // because a running agent is something you may need to act on.
      //
      // Incognito is the same shape of rule with a harder edge. A marked session shows while it is
      // open, in its own section, and is gone the instant it closes -- not shelved, not one flag
      // away, absent. So the liveness set is the whole test, and this is the only place in the
      // sidebar that decides it, which is why the projection is left to route the survivors rather
      // than to re-derive who they are.
      const liveSessionIds = allLiveSessionIdsFrom(bridge);
      const incognitoAndClosed = (session: { sessionId: string; resumeId: string }): boolean =>
        (catalogue.incognito.has(session.sessionId) || catalogue.incognito.has(session.resumeId))
        && !liveSessionIds.has(session.sessionId)
        && !liveSessionIds.has(session.resumeId);
      const visible = index.sessions.filter(
        (session) => !catalogue.auxiliary.has(session.sessionId)
          && !catalogue.auxiliary.has(session.resumeId)
          && !incognitoAndClosed(session),
      );
      // Only live rows carrying an enrichment pay for any of this. The index refreshes on a timer,
      // so its message count trails a session that is still typing; reading the bytes it has not
      // parsed yet turns "something happened" into a number.
      //
      // A closed session cannot type, so its indexed count is already as true as it will get and
      // the read buys nothing. That distinction did not matter when the list held a dozen rows and
      // this cost 1.0 ms; it decides the whole thing at four hundred, because `statSync` is
      // synchronous and the `Promise.all` around it parallelises none of the waiting. Measured on
      // the live store, this pass reached 6.2 seconds and blocked the event loop for all of it.
      //
      // The cost of skipping is bounded and self-healing: a session that ends between one index
      // refresh and the next carries a slightly stale `messagesSince` until the next reindex, on a
      // row nobody is working on.
      //
      // `liveSessionIds` is the set computed above for the incognito filter; the two uses want
      // exactly the same answer, and reading the bridge twice in one snapshot could give them
      // different ones.
      phaseStartedAt = performance.now();
      const indexed = await Promise.all(visible.map(async (session) => {
        const live = liveSessionIds.has(session.sessionId) || liveSessionIds.has(session.resumeId);
        if (!live || !catalogue.summaries.has(session.sessionId)) {
          return { ...session, transcriptMtimeMs: null };
        }
        const exact = await readExactMessageCount(session);
        return {
          ...session,
          messageCount: exact ?? session.messageCount ?? null,
          // The mtime fallback is only consulted when the exact count could not be established;
          // asking for it otherwise would be a stat per row for an answer already known.
          transcriptMtimeMs: exact === null && session.transcriptPath
            ? transcriptMtime(session.transcriptPath)
            : null,
        };
      }));
      const messageCountMs = performance.now() - phaseStartedAt;

      phaseStartedAt = performance.now();
      const statuses = bridge.readable
        ? await statusReader.read(bridge.workspaceIds())
        : new Map<string, CmuxStatusRead>();
      const statusMs = performance.now() - phaseStartedAt;

      const pinnedWorkspaces = pinnedWorkspacesFrom(bridge);
      const live = liveSessionsFrom(bridge, pinnedWorkspaces, statuses);
      // Sessionless workspaces have no hook-store cwd, so cmux's own per-workspace record is the
      // only truthful source for the directory their row names.
      const sessionless = liveWorkspacesFrom(bridge, pinnedWorkspaces);
      phaseStartedAt = performance.now();
      const workspaceStates = sessionless.length > 0
        ? await workspaceStateReader.read(sessionless.map((entry) => entry.workspaceId))
        : new Map<string, null>();
      const workspaceStateMs = performance.now() - phaseStartedAt;
      const workspaces: LiveWorkspaceInput[] = sessionless.map((entry) => ({
        ...entry,
        cwd: workspaceStates.get(entry.workspaceId)?.cwd ?? null,
      }));
      const indexedForScope = indexed.filter((session) =>
        lifecycles.includes(lifecycleForIndexedSession(session, catalogue.lifecycles)));
      phaseStartedAt = performance.now();
      const facts = await directoryFacts.lookup([
        ...directoriesToResolve(
          live,
          indexedForScope,
          scope === "active" ? RECENT_LIMIT : HISTORY_LIMIT,
        ),
        ...workspaces.flatMap((entry) => (entry.cwd ? [entry.cwd] : [])),
      ]);
      const directoryFactsMs = performance.now() - phaseStartedAt;

      phaseStartedAt = performance.now();
      const notifications = bridge.readable
        ? await notificationReader.read()
        : null;
      const notificationsMs = performance.now() - phaseStartedAt;
      phaseStartedAt = performance.now();
      const categoryProjection = readCategories(cataloguePath, categoryRegistryPath);
      const snapshot = projectSidebar({
        live,
        workspaces,
        liveSessionIds,
        indexed,
        lifecycles: catalogue.lifecycles,
        catalogueLifecycles: catalogue.catalogueLifecycles,
        canonicalSessionIds: catalogue.canonicalSessionIds,
        scope,
        checkouts: facts.checkouts,
        faviconDirectories: new Set(facts.favicons.keys()),
        unreadByWorkspaceId: notifications?.unreadCountsByWorkspaceId,
        summaries: catalogue.summaries,
        preferredTitles: catalogue.preferredTitles,
        memberships: catalogue.memberships,
        incognitoSessionIds: catalogue.incognito,
        categories: categoryProjection.status === "ok" ? categoryProjection.categories : new Map(),
        categoryProjectionError: categoryProjection.status === "unavailable" ? categoryProjection.error : null,
        triageOnly,
        incognitoOnly,
        includeLifecycles: lifecycles.filter((lifecycle) => lifecycle !== "active"),
        lifecycleCounts: {
          active: catalogue.sessionIds.get("active")?.length ?? 0,
          completed: catalogue.sessionIds.get("completed")?.length ?? 0,
          saved: catalogue.sessionIds.get("saved")?.length ?? 0,
        },
        livenessReadable: bridge.readable,
        indexReadable: index.readable,
        catalogueReadable: catalogue.readable,
        hasMoreRows,
        now: now(),
        recentLimit,
        historyLimit,
      });

      // Authorize exactly the directories this returned snapshot exposed, not the wider set scanned
      // while searching for enough recent rows. Replacing the map also revokes vanished rows.
      const publishedDirectories = new Set(
        snapshot.rows.flatMap((row) => row.directoryPath ? [row.directoryPath] : []),
      );
      favicons = new Map(
        [...facts.favicons].filter(([directory]) => publishedDirectories.has(directory)),
      );
      const projectionMs = performance.now() - phaseStartedAt;
      const measurement: SidebarSnapshotMeasurement = {
        view,
        rowCount: snapshot.rows.length,
        totalMs: performance.now() - snapshotStartedAt,
        phases: {
          bridgeMs,
          catalogueMs,
          indexMs,
          statusMs,
          workspaceStateMs,
          messageCountMs,
          directoryFactsMs,
          notificationsMs,
          projectionMs,
        },
        livenessReadable: snapshot.livenessReadable,
        catalogueReadable: snapshot.catalogueReadable,
        indexReadable: snapshot.indexReadable,
      };
      observeSnapshot?.(measurement);
      observe?.(measurement);
      return snapshot;
    },

    async refreshSnapshotLivenessNow(): Promise<void> {
      await snapshotLiveness.refreshNow();
    },

    refreshSnapshotLiveness(): void {
      snapshotLiveness.refresh();
    },

    faviconFor(directory: string): string | null {
      return favicons.get(directory) ?? null;
    },

    async closeLooseWorkspace(workspaceId: string): Promise<CloseWorkspaceOutcome> {
      const bridge = await readBridge();
      if (!bridge.readable) return { status: "liveness-unreadable" };
      const surfaces = bridge.surfacesInWorkspace(workspaceId);
      if (surfaces.length === 0) return { status: "not-live" };
      if (surfaces.some((surface) => bridge.surfaceInfo(surface.surfaceId) !== null)) {
        return { status: "failed", reason: "that workspace runs a session; close it as a session" };
      }
      const closed = await processAdapter.run(
        cmuxBin,
        ["close-workspace", "--workspace", workspaceId],
        { timeoutMs: 5_000 },
      );
      if (closed.timedOut) return { status: "timeout" };
      return closed.ok
        ? { status: "closed" }
        : { status: "failed", reason: "cmux refused to close the workspace" };
    },

    async setPinned(workspaceId: string, pinned: boolean): Promise<PinWorkspaceOutcome> {
      const bridge = await readBridge();
      if (!bridge.readable) return { status: "liveness-unreadable" };
      if (bridge.surfacesInWorkspace(workspaceId).length === 0) return { status: "not-live" };
      const changed = await processAdapter.run(
        cmuxBin,
        ["workspace-action", "--action", pinned ? "pin" : "unpin", "--workspace", workspaceId],
        { timeoutMs: 3_000 },
      );
      if (changed.timedOut) return { status: "timeout" };
      return changed.ok
        ? { status: "pinned", pinned }
        : { status: "failed", reason: `cmux refused to ${pinned ? "pin" : "unpin"} the workspace` };
    },

    async focusWorkspace(workspaceId: string): Promise<FocusWorkspaceOutcome> {
      const outcome = await actionCoordinator.focusWorkspace(workspaceId);
      return outcome.status === "focused" ? { status: "focused" } : outcome;
    },

    async closeWorkspace(sessionId: string): Promise<CloseWorkspaceOutcome> {
      const outcome = await closeThroughPrimitive(sessionId, true);
      switch (outcome.status) {
        case "closed":
          return { status: "closed" };
        case "authorized":
          return { status: "failed", reason: closeFailureReason(outcome) };
        case "close-failed":
          return { status: "failed", reason: closeFailureReason(outcome) };
        case "refused":
          if (outcome.reason === "bridge-unreadable") {
            return { status: "liveness-unreadable" };
          }
          if (outcome.reason === "session-not-live" && outcome.phase === "preflight") {
            return { status: "not-live" };
          }
          // The refusal code travels with the text: one for the log, one safe enough to show.
          return {
            status: "failed",
            reason: closeFailureReason(outcome),
            refusal: outcome.reason,
          };
      }
    },

    /**
     * Done/Save delegates the whole ordered gesture to the CCS primitive. Reversing remains
     * lifecycle-only because there is no enrichment or workspace retirement to perform.
     */
    async retire(
      sessionId: string,
      action: SessionLifecycleAction,
    ): Promise<SessionLifecycleOutcome> {
      if (action === "uncomplete" || action === "unsave") {
        return updateLifecycle(sessionId, action);
      }

      const recorded: { outcome: SessionLifecycleOutcome | null } = { outcome: null };
      const finishDependencies: FinishSessionDependencies = {
        recordLifecycle(targetSessionId: string, lifecycle: FinishLifecycle): Result<void> {
          const outcome = updateLifecycle(targetSessionId, lifecycle);
          recorded.outcome = outcome;
          if (outcome.status === "ok") return ok(undefined);
          if (outcome.status === "not-found") {
            return err(new Error("the session is absent from the catalogue"));
          }
          if (outcome.status === "catalogue-unreadable") {
            return err(new Error("the session catalogue is unavailable"));
          }
          return err(new Error(outcome.reason));
        },
        launchEnrichment,
        closeSessionWorkspace: closeThroughPrimitive,
      };
      const finished: FinishSessionOutcome = await runFinishSession(
        sessionId,
        action,
        true,
        finishDependencies,
      );

      switch (finished.status) {
        case "invalid-session":
          return { status: "failed", reason: finished.error.message };
        case "lifecycle-failed":
          if (recorded.outcome?.status === "not-found") return recorded.outcome;
          if (recorded.outcome?.status === "catalogue-unreadable") return recorded.outcome;
          if (recorded.outcome?.status === "failed") return recorded.outcome;
          return { status: "failed", reason: "the session lifecycle could not be updated" };
        case "close-result": {
          if (finished.enrichmentWarning) {
            log.warn("sidebar immediate enrichment launch failed", {
              error: finished.enrichmentWarning,
              sessionId,
            });
          }
          if (!finished.lifecycleRecorded || recorded.outcome?.status !== "ok") {
            return { status: "failed", reason: "the session lifecycle result was unavailable" };
          }

          const lifecycleOutcome = recorded.outcome;
          if (finished.close.status === "closed") return lifecycleOutcome;
          if (
            finished.close.status === "refused"
            && finished.close.reason === "session-not-live"
            && finished.close.phase === "preflight"
          ) {
            return lifecycleOutcome;
          }
          return {
            status: "ok",
            lifecycle: lifecycleOutcome.lifecycle,
            closeFailed: closeFailureReason(finished.close),
          };
        }
      }
    },

    async setLifecycle(
      sessionId: string,
      action: SessionLifecycleAction,
    ): Promise<SessionLifecycleOutcome> {
      return updateLifecycle(sessionId, action);
    },

    async declineSuggestion(sessionId: string, verb: string): Promise<DeclineOutcome> {
      const outcome = declineCommand(sessionId, verb, catalogueCommandOptions);
      if (outcome.status === "not-found") return outcome;
      if (outcome.status === "catalogue-unreadable") return outcome;
      return { status: "ok" };
    },

    async setIncognito(sessionId: string, incognito: boolean): Promise<IncognitoOutcome> {
      const outcome = markSessionIncognito(sessionId, incognito, destroyOptions());
      if (outcome.status === "ok") return outcome;
      log.warn("sidebar could not change a session's incognito mark", {
        error: outcome.reason,
        sessionId,
      });
      return { status: "catalogue-unreadable" };
    },

    async destroyPreflight(sessionId: string): Promise<DestroyPreflightOutcome> {
      return previewDestroy(sessionId, destroyOptions());
    },

    async destroySession(sessionId: string): Promise<DestroyOutcomeReport> {
      return destroySessionTree(sessionId, destroyOptions());
    },

    async open(sessionId: string): Promise<OpenSessionOutcome> {
      return actionCoordinator.open(sessionId);
    },
  };
}
