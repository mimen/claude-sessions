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
 * Liveness = (`activeSessionsBySurface` ∪ `sessions[sid].surfaceId`), pid-alive-filtered,
 * INTERSECTED with the live tree. Three signals guard against three real failure modes cmux
 * exhibits on 0.64.17:
 *   - unioning both hook-store views handles reattach — `activeSessionsBySurface` goes stale
 *     when a `--resume` binds to a new surface, `sessions[sid].surfaceId` is the fresher pointer.
 *   - pid-alive (`process.kill(pid, 0)`) drops sessions whose claude process is actually dead
 *     but whose stop hook never fired (crash, kill -9, cmux restart) — the store keeps them
 *     as `agentLifecycle: running` forever otherwise.
 *   - tree intersect drops anything whose surface is no longer visible.
 * Identity/liveness key on the SURFACE UUID. The workspace tab is owned by the
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
  /** the pid cmux's hooks last recorded for this session, if any. The ground-truth liveness
   * check: we treat this session as live only if this pid is still an alive process. cmux can
   * fail to fire the stop hook (crash, kill -9), leaving the store claiming a dead session is
   * `agentLifecycle: running` — the pid check catches that. */
  pid: number | null;
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
  pid?: number | null;
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
 * We UNION two views the hook store exposes:
 *   - `activeSessionsBySurface[surfaceId] = {sessionId}` — cmux's authoritative-for-a-current-
 *     surface map, but empirically stale on 0.64.17: when a `--resume` reattaches a session onto
 *     a new surface (fleet resumes), the OLD surface's binding is left in place and the new
 *     surface never gets one. Sessions that ARE live disappear from this view.
 *   - `sessions[sessionId].surfaceId` — per-session detail; cmux's hooks overwrite `.surfaceId`
 *     with the current surface each time the session announces itself. This tends to be fresher
 *     than the byMap for reattached sessions.
 *
 * Buildbridge intersects the resulting map with the live surface tree (surfaceToWorkspace) — so
 * `activeSessionsBySurface` entries whose surface is gone drop out, and `sessions[sid].surfaceId`
 * pointing at a stale surface drops out too. Only a binding whose surface is CURRENTLY in the
 * tree survives, so unioning both views is safe: stale garbage in either is filtered downstream.
 *
 * Precedence: `activeSessionsBySurface` is inserted first (its `updatedAt` is the surface-side
 * binding time); `sessions[sid].surfaceId` fills in any surface it doesn't already cover.
 * Duplicate coverage of the same surface reconciles to the same sessionId in practice.
 */
export function parseHookStore(store: CmuxHookStore): Map<string, SurfaceSession> {
  const map = new Map<string, SurfaceSession>();
  const sessions = store.sessions ?? {};
  const record = (surfaceId: string, sessionId: string): void => {
    if (!surfaceId || !sessionId) return;
    if (map.has(surfaceId)) return;
    const detail = sessions[sessionId] ?? {};
    map.set(surfaceId, {
      sessionId,
      workspaceId: detail.workspaceId ?? null,
      cwd: detail.cwd ?? null,
      agentLifecycle: detail.agentLifecycle ?? null,
      isRestorable: detail.isRestorable ?? false,
      pid: typeof detail.pid === "number" ? detail.pid : null,
    });
  };
  for (const [surfaceId, binding] of Object.entries(store.activeSessionsBySurface ?? {})) {
    if (binding?.sessionId) record(surfaceId, binding.sessionId);
  }
  // Fill in sessions whose current .surfaceId isn't covered by activeSessionsBySurface (0.64.17
  // regression: reattached sessions leave the byMap stale). The buildBridge tree-intersect drops
  // any that point at a surface that no longer exists.
  for (const [sessionId, detail] of Object.entries(sessions)) {
    const surfaceId = detail?.surfaceId;
    if (surfaceId) record(surfaceId, sessionId);
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
  /**
   * pid liveness predicate: `pidAlive(pid) === false` drops a hook-store binding whose recorded
   * claude pid is no longer running. cmux can fail to fire the stop hook (crash, kill -9, cmux
   * restart), leaving `sessions[sid]` claiming a session is `agentLifecycle: running` while the
   * process is long gone. Filtering by real pid liveness cleans those phantoms out. Default is
   * "always alive" (pure/testable). Live callers pass a probe backed by `process.kill(pid, 0)`.
   * A binding with no recorded pid is trusted (surface-in-tree check still applies) — cmux
   * pre-hook-store sessions never had a pid to record, so refusing them would be too aggressive.
   */
  pidAlive: (pid: number) => boolean = () => true,
): Bridge {
  const surfaces = parseTree(tree);
  const agents = parseHookStore(store);

  const surfaceToWorkspace = new Map<string, SurfaceLocation>();
  for (const s of surfaces) surfaceToWorkspace.set(s.surfaceId, s);

  // Filter out bindings whose recorded pid is dead (see pidAlive comment above). Bindings with
  // no pid pass through — the surface-in-tree check below is the only guard for them.
  const livePidAgents = new Map<string, SurfaceSession>();
  for (const [surfaceId, agent] of agents) {
    if (agent.pid != null && !pidAlive(agent.pid)) continue;
    livePidAgents.set(surfaceId, agent);
  }

  // sessionId -> surfaceId, only for surfaces that are actually live in the tree
  const sessionToSurface = new Map<string, string>();
  for (const [surfaceId, agent] of livePidAgents) {
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
    livePidAgents.get(surfaceId) ?? null;

  const surfacesInWorkspace = (workspaceId: string): SurfaceLocation[] =>
    [...(byWorkspace.get(workspaceId) ?? [])].sort(
      (a, b) => a.paneIndex - b.paneIndex || a.indexInPane - b.indexInPane,
    );

  const primarySurface = (workspaceId: string): SurfaceLocation | null => {
    for (const s of surfacesInWorkspace(workspaceId)) {
      if (livePidAgents.has(s.surfaceId)) return s; // earliest claude-running surface wins the tab
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
