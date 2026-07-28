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
import type { Database } from "bun:sqlite";
import { openIndex } from "../index/schema.ts";
import {
  displayTitle,
  getAll,
  getRow,
  lifecycleOf,
  openCatalogue,
} from "../catalogue/db.ts";
import { setIdentityFields } from "../catalogue/identities.ts";
import { DB_PATH, CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { liveBridgeAsync } from "../cmux/live.ts";
import {
  focusSession,
  focusWorkspace as focusWorkspaceById,
  setWorkspacePinned,
} from "../cmux/liveness.ts";
import type { Bridge } from "../cmux/bridge.ts";
import {
  closeSessionWorkspaceCandidates,
  closeWorkspaceByStableIdWithCmux,
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
import { resumeSessionEntry } from "../resume/resume-session.ts";
import { loadLaunchers } from "../resume/launchers.ts";
import { log } from "../logger.ts";
import { err, ok, type Result } from "../result.ts";
import { readIndexReadOnly } from "./index-read.ts";
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
  directoriesToResolve,
  projectSidebar,
  sidebarLifecycleOf,
  type IndexedSessionInput,
  type LiveSessionInput,
  type LiveWorkspaceInput,
  type SidebarLifecycle,
  type SidebarScope,
  type SidebarSnapshot,
} from "./projection.ts";
import {
  readEnrichments,
  type StoredEnrichment,
} from "../catalogue/enrichment.ts";

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

export type OpenSessionOutcome =
  | { readonly status: "focused"; readonly workspaceRef: string | null }
  | { readonly status: "resumed"; readonly workspaceRef: string | null }
  | { readonly status: "not-found" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

export type SessionLifecycleAction = "complete" | "archive" | "uncomplete" | "unarchive";

export type SessionLifecycleOutcome =
  | {
    readonly status: "ok";
    readonly lifecycle: SidebarLifecycle;
    /** Set when the catalogue write landed but the workspace would not close. */
    readonly closeFailed?: string;
  }
  | { readonly status: "not-found" }
  | { readonly status: "failed"; readonly reason: string };

/** Read the current picture and act on one row. Nothing else is exposed to callers. */
export type CloseWorkspaceOutcome =
  | { readonly status: "closed" }
  /** Nothing to close: the session has no live workspace. */
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

export type FocusWorkspaceOutcome =
  | { readonly status: "focused" }
  /** The workspace is no longer in the live tree, so there is nothing to focus. */
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

export type PinWorkspaceOutcome =
  | { readonly status: "pinned"; readonly pinned: boolean }
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "failed"; readonly reason: string };

export interface SidebarSource {
  /** `rowLimit` is how many rows the caller has room for; it grows as the client scrolls. */
  snapshot(scope?: SidebarScope, rowLimit?: number): Promise<SidebarSnapshot>;
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

/**
 * Execute the primitive's already-authorized stable-UUID close. The sidebar never calls cmux's
 * close verb on its own; all target resolution and both safety proofs stay in close-current.ts.
 */
function closeWorkspaceRef(workspaceId: string, _windowRef: string, cmuxBin: string): boolean {
  return closeWorkspaceByStableIdWithCmux(cmuxBin, workspaceId).ok;
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

interface CatalogueLifecycleState {
  readonly lifecycles: ReadonlyMap<string, SidebarLifecycle>;
  readonly canonicalSessionIds: ReadonlyMap<string, string>;
  /** Titles the catalogue owns (human, then enrichment); the index title is the fallback. */
  readonly preferredTitles: ReadonlyMap<string, string>;
  readonly sessionIds: ReadonlyMap<SidebarLifecycle, readonly string[]>;
  /** Delegated seats, hidden the way `ccs ls` hides them. */
  readonly auxiliary: ReadonlySet<string>;
  /** Enrichment summaries keyed by canonical id and resume alias; absent for unenriched sessions. */
  readonly summaries: ReadonlyMap<string, StoredEnrichment>;
}

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

function mirrorLifecycleToFleetIdentity(
  db: Database,
  identityKey: string | null,
  field: "completed" | "archived",
  value: boolean,
  changedAt: string,
): void {
  if (!identityKey) return;
  try {
    const identity = db.query(
      "SELECT kind FROM identities WHERE identity_key = $key",
    ).get({ $key: identityKey }) as { kind: string } | null;
    // Core identities span several session lifetimes, so retiring one body must stay per-session.
    if (!identity || identity.kind === "core") return;
    setIdentityFields(db, identityKey, { [field]: value }, changedAt);
  } catch {
    // The session write is authoritative; mark() also treats an identity mirror as best-effort.
  }
}

type ResumeSessionCall = (
  indexDb: Database,
  catalogueDb: Database,
  sessionId: string,
  options: Parameters<typeof resumeSessionEntry>[3],
) => ReturnType<typeof resumeSessionEntry> | Promise<ReturnType<typeof resumeSessionEntry>>;

interface DirectoryFactsReader {
  lookup(directories: readonly string[]): Promise<DirectoryFactsResult>;
}

export interface SidebarSourceOptions {
  /** Override the cmux binary used by status, focus, and resume commands. */
  readonly cmuxBin?: string;
  readonly now?: () => number;
  readonly recentlyResumedMs?: number;
  /** Narrow I/O seams keep source tests away from the real cmux process and session spawner. */
  readonly readBridge?: () => Promise<Bridge>;
  readonly readStatuses?: typeof readClaudeStatuses;
  readonly statusReader?: CachedStatusReader;
  readonly workspaceStateReader?: CachedWorkspaceStateReader;
  readonly notificationReader?: CachedNotificationReader;
  readonly focus?: typeof focusSession;
  /** Invoked only after the CCS primitive authorizes a stable workspace UUID twice. */
  readonly closeCmuxWorkspace?: (workspaceId: string, windowRef: string, cmuxBin: string) => boolean;
  readonly closeSessionWorkspaces?: typeof closeSessionWorkspaceCandidates;
  readonly finishSession?: typeof finishSession;
  readonly launchEnrichment?: FinishSessionDependencies["launchEnrichment"];
  readonly loadLaunchers?: typeof loadLaunchers;
  readonly resumeSession?: ResumeSessionCall;
  readonly openIndex?: typeof openIndex;
  readonly openCatalogue?: typeof openCatalogue;
  readonly ensureDataDir?: typeof ensureDataDir;
  readonly indexedSessions?: () => IndexedSessionInput[];
  readonly directoryFacts?: DirectoryFactsReader;
}

/** The production source, reading live cmux state and the local session index. */
export function createSidebarSource(options: SidebarSourceOptions = {}): SidebarSource {
  const cmuxBin = options.cmuxBin ?? "cmux";
  const now = options.now ?? (() => Date.now());
  const recentlyResumedMs = options.recentlyResumedMs ?? RECENTLY_RESUMED_MS;
  const readBridge = options.readBridge ?? liveBridgeAsync;
  const readStatuses = options.readStatuses ?? readClaudeStatuses;
  // Requests read this cache rather than spawning a subprocess per workspace.
  const statusReader: CachedStatusReader = options.statusReader
    ?? createCachedStatusReader(cmuxBin, STATUS_TTL_MS, now, readStatuses);
  const workspaceStateReader: CachedWorkspaceStateReader = options.workspaceStateReader
    ?? createCachedWorkspaceStateReader(cmuxBin, WORKSPACE_STATE_TTL_MS, now);
  const notificationReader: CachedNotificationReader = options.notificationReader
    ?? createCachedNotificationReader(cmuxBin, NOTIFICATION_TTL_MS, now);
  const focus = options.focus ?? focusSession;
  const closeCmux = options.closeCmuxWorkspace ?? closeWorkspaceRef;
  const closeSessionWorkspaces = options.closeSessionWorkspaces ?? closeSessionWorkspaceCandidates;
  const runFinishSession = options.finishSession ?? finishSession;
  const launchEnrichment = options.launchEnrichment ?? launchImmediateEnrichment;
  const launcherLoader = options.loadLaunchers ?? loadLaunchers;
  const resume = options.resumeSession ?? resumeSessionEntry;
  const openIndexDb = options.openIndex ?? openIndex;
  const openCatalogueDb = options.openCatalogue ?? openCatalogue;
  const ensureDataDirectory = options.ensureDataDir ?? ensureDataDir;
  const readIndexedSessionsOverride = options.indexedSessions;
  // Only directories the latest snapshot published can serve an icon; the map is replaced on
  // each snapshot so a directory that disappears stops being servable.
  let favicons = new Map<string, string>();
  const directoryFacts = options.directoryFacts ?? createDirectoryFactsCache(now);
  const resumeFlights = new Map<string, Promise<OpenSessionOutcome>>();
  const recentlyResumed = new Map<
    string,
    { readonly until: number; readonly workspaceRef: string | null }
  >();

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
        : readIndexReadOnly(DB_PATH(), { limit, sessionIds });
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

  function readCatalogueLifecycles(): Result<CatalogueLifecycleState> {
    let catalogueDb: Database | null = null;
    try {
      ensureDataDirectory();
      catalogueDb = openCatalogueDb(CATALOGUE_PATH());
      const rows = getAll(catalogueDb);
      const lifecycles = new Map<string, SidebarLifecycle>();
      /**
       * Catalogue-owned titles, resolved by `displayTitle` itself rather than by reimplementing
       * its precedence here. Passing an empty fallback makes it return only what the catalogue
       * owns -- a human's title, then enrichment's -- so the projection supplies the index title
       * as the last resort and the ordering stays defined in exactly one place.
       */
      const preferredTitles = new Map<string, string>();
      // Delegated seats — reviewers, implementers — are real sessions but not work anyone
      // browses. `ccs ls` hides `sessionClass === "auxiliary"` unless asked, and the sidebar
      // is the same kind of surface, so it hides them too.
      const auxiliary = new Set<string>();
      const canonicalSessionIds = new Map<string, string>();
      const sessionIds = new Map<SidebarLifecycle, string[]>([
        ["active", []],
        ["completed", []],
        ["archived", []],
      ]);

      // Canonical ids win over aliases when a historical resume id collides with another row.
      for (const row of rows.values()) {
        const lifecycle = sidebarLifecycleOf(lifecycleOf(row));
        lifecycles.set(row.sessionId, lifecycle);
        canonicalSessionIds.set(row.sessionId, row.sessionId);
        // Empty fallback: whatever comes back is catalogue-owned, so an absent one means the
        // index title still wins.
        const preferred = displayTitle(row, "");
        if (preferred) {
          preferredTitles.set(row.sessionId, preferred);
          if (row.resumeId) preferredTitles.set(row.resumeId, preferred);
        }
        if (row.sessionClass === "auxiliary") {
          auxiliary.add(row.sessionId);
          if (row.resumeId) auxiliary.add(row.resumeId);
          continue;
        }
        sessionIds.get(lifecycle)?.push(row.sessionId);
      }
      for (const row of rows.values()) {
        if (!row.resumeId || lifecycles.has(row.resumeId)) continue;
        lifecycles.set(row.resumeId, sidebarLifecycleOf(lifecycleOf(row)));
        canonicalSessionIds.set(row.resumeId, row.sessionId);
      }

      return ok({
        lifecycles,
        preferredTitles,
        canonicalSessionIds,
        sessionIds,
        auxiliary,
        summaries: readEnrichments(catalogueDb),
      });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    } finally {
      catalogueDb?.close();
    }
  }

  function readCatalogueLifecyclesSafely(): CatalogueLifecycleState & {
    readonly readable: boolean;
  } {
    const result = readCatalogueLifecycles();
    if (result.ok) return { ...result.value, readable: true };
    log.warn("sidebar could not read the session catalogue; lifecycle degraded to active", {
      error: result.error.message,
    });
    return {
      lifecycles: new Map(),
      canonicalSessionIds: new Map(),
      preferredTitles: new Map<string, string>(),
      // Nothing is known to be auxiliary when the catalogue is unreadable, so nothing is hidden.
      auxiliary: new Set<string>(),
      summaries: new Map<string, StoredEnrichment>(),
      sessionIds: new Map<SidebarLifecycle, readonly string[]>([
        ["active", []],
        ["completed", []],
        ["archived", []],
      ]),
      readable: false,
    };
  }

  function updateLifecycle(
    sessionId: string,
    action: SessionLifecycleAction,
  ): SessionLifecycleOutcome {
    let catalogueDb: Database | null = null;
    try {
      ensureDataDirectory();
      catalogueDb = openCatalogueDb(CATALOGUE_PATH());
      const existing = getRow(catalogueDb, sessionId);
      if (existing === null) return { status: "not-found" };

      const changedAt = new Date(now()).toISOString();
      const field = action === "complete" || action === "uncomplete"
        ? "completed"
        : "archived";
      const value = action === "complete" || action === "archive";
      const lifecycleUpdate = field === "completed"
        ? "UPDATE catalogue SET completed = $value, updated_at = $changedAt WHERE session_id = $sessionId"
        : "UPDATE catalogue SET archived = $value, updated_at = $changedAt WHERE session_id = $sessionId";
      catalogueDb.query(lifecycleUpdate).run({
        $value: value ? 1 : 0,
        $changedAt: changedAt,
        $sessionId: sessionId,
      });
      mirrorLifecycleToFleetIdentity(
        catalogueDb,
        existing.identityKey,
        field,
        value,
        changedAt,
      );

      return {
        status: "ok",
        lifecycle: sidebarLifecycleOf(lifecycleOf(getRow(catalogueDb, sessionId))),
      };
    } catch (error) {
      log.warn("sidebar could not update session lifecycle", {
        error: error instanceof Error ? error.message : String(error),
        action,
        sessionId,
      });
      return { status: "failed", reason: "the session catalogue could not be updated" };
    } finally {
      catalogueDb?.close();
    }
  }

  function ensureCatalogueSessionRow(sessionId: string): Result<void> {
    let catalogueDb: Database | null = null;
    try {
      ensureDataDirectory();
      catalogueDb = openCatalogueDb(CATALOGUE_PATH());
      catalogueDb.query(
        "INSERT INTO catalogue (session_id, updated_at) VALUES ($id, $now) "
          + "ON CONFLICT(session_id) DO NOTHING",
      ).run({ $id: sessionId, $now: new Date(now()).toISOString() });
      return ok(undefined);
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    } finally {
      catalogueDb?.close();
    }
  }

  function closeCandidateIds(sessionId: string): readonly string[] {
    const index = readIndexedSessionsSafely(INDEX_SCAN_LIMIT);
    const row = index.sessions.find(
      (candidate) => candidate.sessionId === sessionId || candidate.resumeId === sessionId,
    );
    return [...new Set([sessionId, row?.sessionId, row?.resumeId].filter(
      (candidate): candidate is string => candidate !== undefined,
    ))];
  }

  function primitiveCloseDependencies(): CloseSessionWorkspaceDependencies {
    return {
      bridge: readBridge,
      close: (workspaceId, location) => ({
        ok: closeCmux(workspaceId, location.windowRef, cmuxBin),
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

  function recentResumeFor(sessionIds: readonly string[]): OpenSessionOutcome | null {
    const current = now();
    for (const [rememberedId, recent] of recentlyResumed) {
      if (recent.until <= current) recentlyResumed.delete(rememberedId);
    }
    for (const sessionId of sessionIds) {
      const recent = recentlyResumed.get(sessionId);
      if (recent) return { status: "focused", workspaceRef: recent.workspaceRef };
    }
    return null;
  }

  function rememberResume(sessionIds: readonly string[], workspaceRef: string | null): void {
    const until = now() + Math.max(0, recentlyResumedMs);
    for (const sessionId of sessionIds) {
      recentlyResumed.set(sessionId, { until, workspaceRef });
    }
  }

  return {
    /**
     * @param rowLimit How many rows the caller has room for. Absent means the default window;
     *   the client raises it as you scroll, which is what makes the list unbounded. The index
     *   scan is widened to match, since a limit the scan cannot feed is not a limit at all.
     */
    async snapshot(scope: SidebarScope = "active", rowLimit?: number): Promise<SidebarSnapshot> {
      const bridge = await readBridge();
      const catalogue = readCatalogueLifecyclesSafely();
      const requestedIds = scope === "active"
        ? undefined
        : catalogue.sessionIds.get(scope) ?? [];
      const recentLimit = rowLimit ?? RECENT_LIMIT;
      const historyLimit = rowLimit ?? HISTORY_LIMIT;
      const index = readIndexedSessionsSafely(
        // Live rows come from cmux, not the index, so the active scan has to cover the shelf
        // plus the live sessions it must skip over; a flat multiple is enough and stays cheap.
        scope === "active" ? Math.max(INDEX_SCAN_LIMIT, recentLimit * 4) : historyLimit,
        requestedIds,
      );
      // Delegated seats never reach the shelf or the history scopes; a live one still shows,
      // because a running agent is something you may need to act on.
      const indexed = index.sessions
        .filter(
          (session) => !catalogue.auxiliary.has(session.sessionId)
            && !catalogue.auxiliary.has(session.resumeId),
        )
        // One stat per row, and only for rows that carry an enrichment worth aging. The index's
        // message count cannot detect drift on a live session -- it is the thing that has not
        // moved -- so the filesystem is asked instead.
        .map((session) => ({
          ...session,
          transcriptMtimeMs: session.transcriptPath
            && catalogue.summaries.has(session.sessionId)
            ? transcriptMtime(session.transcriptPath)
            : null,
        }));

      const statuses = bridge.readable
        ? await statusReader.read(bridge.workspaceIds())
        : new Map<string, CmuxStatusRead>();

      const pinnedWorkspaces = pinnedWorkspacesFrom(bridge);
      const live = liveSessionsFrom(bridge, pinnedWorkspaces, statuses);
      // Sessionless workspaces have no hook-store cwd, so cmux's own per-workspace record is the
      // only truthful source for the directory their row names.
      const sessionless = liveWorkspacesFrom(bridge, pinnedWorkspaces);
      const workspaceStates = sessionless.length > 0
        ? await workspaceStateReader.read(sessionless.map((entry) => entry.workspaceId))
        : new Map<string, null>();
      const workspaces: LiveWorkspaceInput[] = sessionless.map((entry) => ({
        ...entry,
        cwd: workspaceStates.get(entry.workspaceId)?.cwd ?? null,
      }));
      const indexedForScope = indexed.filter((session) =>
        lifecycleForIndexedSession(session, catalogue.lifecycles) === scope);
      const facts = await directoryFacts.lookup([
        ...directoriesToResolve(
          live,
          indexedForScope,
          scope === "active" ? RECENT_LIMIT : HISTORY_LIMIT,
        ),
        ...workspaces.flatMap((entry) => (entry.cwd ? [entry.cwd] : [])),
      ]);
      const notifications = bridge.readable
        ? await notificationReader.read()
        : null;
      const snapshot = projectSidebar({
        live,
        workspaces,
        liveSessionIds: allLiveSessionIdsFrom(bridge),
        indexed,
        lifecycles: catalogue.lifecycles,
        canonicalSessionIds: catalogue.canonicalSessionIds,
        scope,
        checkouts: facts.checkouts,
        faviconDirectories: new Set(facts.favicons.keys()),
        unreadByWorkspaceId: notifications?.unreadCountsByWorkspaceId,
        summaries: catalogue.summaries,
        preferredTitles: catalogue.preferredTitles,
        lifecycleCounts: {
          active: catalogue.sessionIds.get("active")?.length ?? 0,
          completed: catalogue.sessionIds.get("completed")?.length ?? 0,
          archived: catalogue.sessionIds.get("archived")?.length ?? 0,
        },
        livenessReadable: bridge.readable,
        indexReadable: index.readable,
        catalogueReadable: catalogue.readable,
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
      return snapshot;
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
      return closeWorkspaceByStableIdWithCmux(cmuxBin, workspaceId).ok
        ? { status: "closed" }
        : { status: "failed", reason: "cmux refused to close the workspace" };
    },

    async setPinned(workspaceId: string, pinned: boolean): Promise<PinWorkspaceOutcome> {
      const bridge = await readBridge();
      if (!bridge.readable) return { status: "liveness-unreadable" };
      if (bridge.surfacesInWorkspace(workspaceId).length === 0) return { status: "not-live" };
      return setWorkspacePinned(workspaceId, pinned, cmuxBin)
        ? { status: "pinned", pinned }
        : { status: "failed", reason: `cmux refused to ${pinned ? "pin" : "unpin"} the workspace` };
    },

    async focusWorkspace(workspaceId: string): Promise<FocusWorkspaceOutcome> {
      const bridge = await readBridge();
      // Fail closed on an unreadable tree: without it there is no way to tell a live workspace
      // from one cmux closed a moment ago, and focusing blind is how you land on the wrong tab.
      if (!bridge.readable) return { status: "liveness-unreadable" };
      const surfaces = bridge.surfacesInWorkspace(workspaceId);
      const location = surfaces[0];
      if (!location) return { status: "not-live" };
      return focusWorkspaceById(workspaceId, location.windowId, cmuxBin)
        ? { status: "focused" }
        : { status: "failed", reason: "cmux refused to focus the workspace" };
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
          return { status: "failed", reason: closeFailureReason(outcome) };
      }
    },

    /**
     * Complete/archive delegates the whole ordered gesture to the CCS primitive. Reversing remains
     * lifecycle-only because there is no enrichment or workspace retirement to perform.
     */
    async retire(
      sessionId: string,
      action: SessionLifecycleAction,
    ): Promise<SessionLifecycleOutcome> {
      if (action === "uncomplete" || action === "unarchive") {
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

    async open(sessionId: string): Promise<OpenSessionOutcome> {
      const bridge = await readBridge();
      if (!bridge.readable) return { status: "liveness-unreadable" };

      const index = readIndexedSessionsSafely(INDEX_SCAN_LIMIT);
      const row = index.sessions.find(
        (candidate) => candidate.sessionId === sessionId || candidate.resumeId === sessionId,
      );

      {

        // A live session is addressed by either id depending on whether it was resumed, so both
        // are tried before concluding it is closed and spawning anything.
        for (const candidate of [sessionId, row?.sessionId, row?.resumeId]) {
          if (!candidate) continue;
          const location = bridge.locateSession(candidate);
          if (!location) continue;
          return focus(candidate, cmuxBin)
            ? { status: "focused", workspaceRef: location.workspaceRef }
            : { status: "failed", reason: "cmux refused to focus the workspace" };
        }

        if (!row) {
          return index.readable
            ? { status: "not-found" }
            : { status: "failed", reason: "the session index is unreadable, so this session cannot be resumed" };
        }
        const identityIds = [...new Set([sessionId, row.sessionId, row.resumeId])];
        const recent = recentResumeFor(identityIds);
        if (recent) return recent;

        // Canonicalize aliases to the indexed session id before coordinating. A second request may
        // have read the same pre-hook bridge, but it shares this flight and therefore cannot spawn.
        const existingFlight = resumeFlights.get(row.sessionId);
        if (existingFlight) {
          const outcome = await existingFlight;
          return outcome.status === "resumed"
            ? recentResumeFor(identityIds) ?? {
              status: "focused",
              workspaceRef: outcome.workspaceRef,
            }
            : outcome;
        }

        const flight = (async (): Promise<OpenSessionOutcome> => {
          const recentInsideFlight = recentResumeFor(identityIds);
          if (recentInsideFlight) return recentInsideFlight;

          const launchers = launcherLoader();
          if (!launchers.ok) {
            return {
              status: "failed",
              reason: `launcher configuration could not be loaded: ${launchers.error.message}`,
            };
          }

          let indexDb: Database;
          try {
            indexDb = openIndexDb(DB_PATH());
          } catch (error) {
            return {
              status: "failed",
              reason: `the session index cannot be opened for resume: ${error instanceof Error ? error.message : String(error)}`,
            };
          }

          let catalogueDb: Database | null = null;
          try {
            try {
              catalogueDb = openCatalogueDb(CATALOGUE_PATH());
            } catch (error) {
              log.warn("sidebar could not open the session catalogue for resume", {
                error: error instanceof Error ? error.message : String(error),
              });
              return {
                status: "failed",
                reason: "the session catalogue cannot be opened for resume",
              };
            }

            const result = await resume(indexDb, catalogueDb, row.sessionId, {
              bridge,
              focus: true,
              cmuxBin,
              launchers: launchers.value,
            });
            switch (result.status) {
              case "resumed":
                rememberResume(identityIds, result.workspaceRef);
                return { status: "resumed", workspaceRef: result.workspaceRef };
              case "already-open": {
                const focusedId = identityIds.find((candidate) => focus(candidate, cmuxBin));
                return focusedId
                  ? {
                    status: "focused",
                    workspaceRef: bridge.locateSession(focusedId)?.workspaceRef ?? null,
                  }
                  : {
                    status: "failed",
                    reason: "session is already open but could not be focused",
                  };
              }
              case "not-indexed":
                return { status: "not-found" };
              case "liveness-unreadable":
                return { status: "liveness-unreadable" };
              default:
                return { status: "failed", reason: result.status };
            }
          } finally {
            catalogueDb?.close();
            indexDb.close();
          }
        })();

        resumeFlights.set(row.sessionId, flight);
        try {
          return await flight;
        } finally {
          if (resumeFlights.get(row.sessionId) === flight) resumeFlights.delete(row.sessionId);
        }
      }
    },
  };
}
