/**
 * cmux bridge — the surface-keyed link between a Claude session and its live cmux body.
 *
 * Established by the 2026-07-09 cmux capability audit (pr-watch docs/adr/0040), REPOINTED for
 * cmux 0.64 (2026-07-11):
 *  - `cmux tree --all --json --id-format both` gives every window/workspace/pane/surface
 *    with a STABLE UUID. A surface resolves to exactly one workspace (1:1 up, no orphans);
 *    a workspace may hold many surfaces (1:many down). This is the ground truth for "what
 *    surface exists RIGHT NOW".
 *  - cmux 0.64 moved Claude session identity out of the app-state file
 *    (`session-com.cmuxterm.app.json`, which no longer records `agent.sessionId`) into a
 *    hook-populated store, `~/.cmuxterm/claude-hook-sessions.json`:
 *      - `sessions[sessionId] = {surfaceId, workspaceId, cwd, transcriptPath, agentLifecycle,
 *        isRestorable, pid, …}` — the per-session detail, ACCRETES history (dead + replaced).
 *      - `activeSessionsBySurface[surfaceUUID] = {sessionId, …}` — the CURRENT binding of a
 *        surface to its live session. This is the authoritative surface→session join.
 *    Only cmux's claude hooks populate it, and only when claude is launched through cmux's
 *    shim (a plain command in an integrated shell — NOT `exec`/env-scrubbed). See ADR-0054.
 *
 * Liveness = `activeSessionsBySurface` INTERSECTED with the live tree: the store accretes stale
 * bindings for surfaces long gone, so a binding only counts if its surface still exists in
 * `cmux tree`. Identity/liveness key on the SURFACE UUID. The workspace tab is owned by the
 * workspace's PRIMARY session = the earliest surface running a claude agent (pane index, then
 * index-in-pane) — a pure function of tree position, no lock (ADR-0027/0032/0040).
 *
 * NOTE (ADR-task #9 hardening): parseTree and parseHookStore assume the cmux 0.64.x tree + hook
 * store JSON shape. A cmux >=0.65 upgrade may require revisiting these parsers if the schema
 * changes. The version guard in live.ts enforces 0.64 at runtime.
 */

// --- shapes of the cmux JSON we consume (only the fields we need) ---------------

interface TreeSurface {
  id: string;
  ref: string;
  type?: string;
  title?: string | null;
  index_in_pane?: number;
  tty?: string | null;
}
interface TreePane {
  id: string;
  ref: string;
  index?: number;
  surfaces?: TreeSurface[];
}
interface TreeWorkspace {
  id: string;
  ref: string;
  title?: string | null;
  panes?: TreePane[];
}
interface TreeWindow {
  id: string;
  ref: string;
  workspaces?: TreeWorkspace[];
}
export interface CmuxTree {
  windows?: TreeWindow[];
}

/** One surface, flattened with its full location up the tree. Identity keys on surfaceId. */
export interface SurfaceLocation {
  surfaceId: string;
  surfaceRef: string;
  surfaceType: string | null;
  title: string | null;
  paneId: string;
  paneIndex: number;
  indexInPane: number;
  workspaceId: string;
  workspaceRef: string;
  workspaceTitle: string | null;
  windowId: string;
  windowRef: string;
}

/** The claude session cmux bound to a surface (keyed by surface UUID). */
export interface SurfaceSession {
  sessionId: string;
  /** the workspace cmux recorded for the session, if any */
  workspaceId: string | null;
  /** the session's cwd as cmux recorded it, if any */
  cwd: string | null;
  /** cmux's agent lifecycle hint (running/needsInput/…), if recorded */
  agentLifecycle: string | null;
  /** whether cmux believes this session can be resumed */
  isRestorable: boolean;
}

// --- parse `cmux tree --all --json --id-format both` ----------------------------

/** Flatten the tree into one row per surface, each carrying its workspace + window. */
export function parseTree(tree: CmuxTree): SurfaceLocation[] {
  const out: SurfaceLocation[] = [];
  for (const win of tree.windows ?? []) {
    for (const ws of win.workspaces ?? []) {
      for (const pane of ws.panes ?? []) {
        for (const s of pane.surfaces ?? []) {
          // Skip surfaces missing the id (ADR-task #9: defensive, matches the workspace guard)
          if (!s.id) continue;
          if (!pane.id) continue; // pane.id must be present (same as surface.id guard)
          out.push({
            surfaceId: s.id,
            surfaceRef: s.ref,
            surfaceType: s.type ?? null,
            title: s.title ?? null,
            paneId: pane.id,
            paneIndex: pane.index ?? 0,
            indexInPane: s.index_in_pane ?? 0,
            workspaceId: ws.id,
            workspaceRef: ws.ref,
            workspaceTitle: ws.title ?? null,
            windowId: win.id,
            windowRef: win.ref,
          });
        }
      }
    }
  }
  return out;
}

// --- parse the cmux 0.64 hook store ---------------------------------------------

/** One entry in `sessions[sessionId]` — the per-session detail cmux's hooks record. */
interface HookSessionEntry {
  sessionId?: string;
  surfaceId?: string | null;
  workspaceId?: string | null;
  cwd?: string | null;
  agentLifecycle?: string | null;
  isRestorable?: boolean;
}
/** One entry in `activeSessionsBySurface[surfaceUUID]` — the CURRENT surface→session binding. */
interface ActiveSurfaceBinding {
  sessionId?: string;
}
/** The shape of `~/.cmuxterm/claude-hook-sessions.json` (only the fields we consume). */
export interface CmuxHookStore {
  sessions?: Record<string, HookSessionEntry>;
  activeSessionsBySurface?: Record<string, ActiveSurfaceBinding>;
}

/**
 * surface UUID -> the claude session cmux currently binds to it.
 *
 * `activeSessionsBySurface` is authoritative for the current binding; `sessions` is the detail
 * lookup (and accretes history). We take the binding and enrich it from the matching session
 * entry. Surfaces whose binding names a session with no detail entry still map (the sessionId
 * alone is enough for liveness) — detail fields just come back null.
 */
export function parseHookStore(store: CmuxHookStore): Map<string, SurfaceSession> {
  const map = new Map<string, SurfaceSession>();
  const sessions = store.sessions ?? {};
  for (const [surfaceId, binding] of Object.entries(store.activeSessionsBySurface ?? {})) {
    const sessionId = binding?.sessionId;
    if (!surfaceId || !sessionId) continue;
    const detail = sessions[sessionId] ?? {};
    map.set(surfaceId, {
      sessionId,
      workspaceId: detail.workspaceId ?? null,
      cwd: detail.cwd ?? null,
      agentLifecycle: detail.agentLifecycle ?? null,
      isRestorable: detail.isRestorable ?? false,
    });
  }
  return map;
}

// --- the bridge -----------------------------------------------------------------

export interface Bridge {
  /** live surfaces, flattened (one per surface, across all windows) */
  surfaces: SurfaceLocation[];
  /** surfaceId -> its location in the live tree */
  surfaceToWorkspace: Map<string, SurfaceLocation>;
  /** all workspace UUIDs that have at least one live surface */
  workspaceIds(): string[];
  /** every live surface in a workspace, tree-ordered (pane, then index-in-pane) */
  surfacesInWorkspace(workspaceId: string): SurfaceLocation[];
  /** the claude session cmux currently binds to a surface, or null */
  surfaceInfo(surfaceId: string): SurfaceSession | null;
  /**
   * Whether the underlying liveness sources were READABLE this snapshot. False means the tree
   * and/or hook store couldn't be read (cmux down, socket unauthed, store missing) — callers that
   * spawn (resume) MUST fail closed on this rather than treat it as "nothing open" (ADR-0054).
   */
  readable: boolean;
  /** locate a session by its Claude session id: its live surface + workspace, or null if closed */
  locateSession(sessionId: string): SurfaceLocation | null;
  /** is this session id currently open (has a live surface)? */
  isOpen(sessionId: string): boolean;
  /** the primary (tab-owning) surface of a workspace: earliest claude-surface, or null */
  primarySurface(workspaceId: string): SurfaceLocation | null;
}

export function buildBridge(
  tree: CmuxTree,
  store: CmuxHookStore,
  readable = true,
): Bridge {
  const surfaces = parseTree(tree);
  const agents = parseHookStore(store);

  const surfaceToWorkspace = new Map<string, SurfaceLocation>();
  for (const s of surfaces) surfaceToWorkspace.set(s.surfaceId, s);

  // sessionId -> surfaceId, only for surfaces that are actually live in the tree
  const sessionToSurface = new Map<string, string>();
  for (const [surfaceId, agent] of agents) {
    if (surfaceToWorkspace.has(surfaceId)) {
      sessionToSurface.set(agent.sessionId, surfaceId);
    }
  }

  const byWorkspace = new Map<string, SurfaceLocation[]>();
  for (const s of surfaces) {
    const list = byWorkspace.get(s.workspaceId) ?? [];
    list.push(s);
    byWorkspace.set(s.workspaceId, list);
  }

  const surfaceInfo = (surfaceId: string): SurfaceSession | null =>
    agents.get(surfaceId) ?? null;

  const surfacesInWorkspace = (workspaceId: string): SurfaceLocation[] =>
    [...(byWorkspace.get(workspaceId) ?? [])].sort(
      (a, b) => a.paneIndex - b.paneIndex || a.indexInPane - b.indexInPane,
    );

  const primarySurface = (workspaceId: string): SurfaceLocation | null => {
    for (const s of surfacesInWorkspace(workspaceId)) {
      if (agents.has(s.surfaceId)) return s; // earliest claude-running surface wins the tab
    }
    return null;
  };

  const locateSession = (sessionId: string): SurfaceLocation | null => {
    const surfaceId = sessionToSurface.get(sessionId);
    return surfaceId ? (surfaceToWorkspace.get(surfaceId) ?? null) : null;
  };

  return {
    surfaces,
    surfaceToWorkspace,
    workspaceIds: () => [...byWorkspace.keys()],
    surfacesInWorkspace,
    surfaceInfo,
    locateSession,
    isOpen: (sessionId) => sessionToSurface.has(sessionId),
    primarySurface,
    readable,
  };
}
