/**
 * cmux bridge — the surface-keyed link between a Claude session and its live cmux body.
 *
 * Established by the 2026-07-09 cmux capability audit (pr-watch docs/adr/0040):
 *  - `cmux tree --all --json --id-format both` gives every window/workspace/pane/surface
 *    with a STABLE UUID. A surface resolves to exactly one workspace (1:1 up, no orphans);
 *    a workspace may hold many surfaces (1:many down).
 *  - cmux's persisted state (`session-com.cmuxterm.app.json`) records, per panel, the
 *    Claude `agent.sessionId` + `resumeBinding`. The panel's UUID EQUALS the surface UUID
 *    in `tree` (verified 25/25 overlap), so the two join on the surface UUID with no
 *    title/cwd guessing.
 *
 * Identity/liveness key on the SURFACE UUID. The workspace tab is owned by the workspace's
 * PRIMARY session = the earliest surface running a claude agent (pane index, then
 * index-in-pane) — a pure function of tree position, no lock (ADR-0027/0032/0040).
 *
 * This supersedes the title-join in open-state.ts, which predated exposing the surface UUID.
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

/** The claude agent cmux persisted for a surface (keyed by surface/panel UUID). */
export interface PersistedAgent {
  sessionId: string;
  workingDirectory: string | null;
  /** the exact `cd … && claude --resume <id>` cmux would replay, if recorded */
  resumeCommand: string | null;
  resumeCwd: string | null;
}

// --- parse `cmux tree --all --json --id-format both` ----------------------------

/** Flatten the tree into one row per surface, each carrying its workspace + window. */
export function parseTree(tree: CmuxTree): SurfaceLocation[] {
  const out: SurfaceLocation[] = [];
  for (const win of tree.windows ?? []) {
    for (const ws of win.workspaces ?? []) {
      for (const pane of ws.panes ?? []) {
        for (const s of pane.surfaces ?? []) {
          if (!s.id) continue;
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

// --- parse the persisted state file --------------------------------------------

interface PersistedTerminal {
  agent?: {
    kind?: string;
    sessionId?: string;
    workingDirectory?: string | null;
  } | null;
  resumeBinding?: {
    command?: string | null;
    cwd?: string | null;
  } | null;
  workingDirectory?: string | null;
}
interface PersistedPanel {
  id?: string;
  terminal?: PersistedTerminal | null;
}
interface PersistedWorkspace {
  panels?: PersistedPanel[];
}
export interface CmuxPersisted {
  windows?: { tabManager?: { workspaces?: PersistedWorkspace[] } }[];
}

/** surface (panel) UUID -> the claude agent cmux persisted for it. */
export function parsePersisted(data: CmuxPersisted): Map<string, PersistedAgent> {
  const map = new Map<string, PersistedAgent>();
  for (const win of data.windows ?? []) {
    for (const ws of win.tabManager?.workspaces ?? []) {
      for (const panel of ws.panels ?? []) {
        const agent = panel.terminal?.agent;
        if (!panel.id || !agent?.sessionId || agent.kind !== "claude") continue;
        const rb = panel.terminal?.resumeBinding ?? null;
        map.set(panel.id, {
          sessionId: agent.sessionId,
          workingDirectory:
            agent.workingDirectory ?? panel.terminal?.workingDirectory ?? null,
          resumeCommand: rb?.command ?? null,
          resumeCwd: rb?.cwd ?? null,
        });
      }
    }
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
  /** the claude agent persisted for a surface, or null */
  surfaceInfo(surfaceId: string): PersistedAgent | null;
  /** locate a session by its Claude session id: its live surface + workspace, or null if closed */
  locateSession(sessionId: string): SurfaceLocation | null;
  /** is this session id currently open (has a live surface)? */
  isOpen(sessionId: string): boolean;
  /** the primary (tab-owning) surface of a workspace: earliest claude-surface, or null */
  primarySurface(workspaceId: string): SurfaceLocation | null;
}

export function buildBridge(tree: CmuxTree, persisted: CmuxPersisted): Bridge {
  const surfaces = parseTree(tree);
  const agents = parsePersisted(persisted);

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

  const surfaceInfo = (surfaceId: string): PersistedAgent | null =>
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
  };
}
