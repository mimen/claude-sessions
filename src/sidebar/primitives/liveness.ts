/**
 * Primitive 3 — liveness, derived from the surface tree and hook bindings.
 *
 * Answers: which sessions are embodied (surface in the live tree), which are ghosts
 * (hook store still claims them, tree does not), and which workspace is focused.
 * Revision is the max of its inputs — it cannot invent a change the sources did not report.
 */
import type { SurfaceLocation } from "../../cmux/bridge.ts";
import type { HookBindingsRead, HookSessionEntry, TranscriptPresence } from "./hook-bindings.ts";
import type { SurfaceTreeRead } from "./surface-tree.ts";

export interface LivenessRow {
  readonly sessionId: string;
  readonly surfaceId: string | null;
  readonly surfaceTitle: string | null;
  readonly workspaceTitle: string | null;
  readonly workspaceRef: string | null;
  readonly workspaceId: string | null;
  readonly trackedLifecycle: string | null;
  readonly surfaceInTree: boolean;
  readonly workspaceFocused: boolean;
  readonly surfaceFocused: boolean;
  readonly pidAlive: boolean | null;
  readonly transcriptState: TranscriptPresence;
}

export interface LivenessRead {
  readonly live: readonly LivenessRow[];
  readonly ghosts: readonly LivenessRow[];
  readonly unboundSurfaces: readonly SurfaceLocation[];
  readonly focusedWorkspaceId: string | null;
  readonly readable: boolean;
  readonly revision: number;
}

function rowFor(
  entry: HookSessionEntry,
  surface: SurfaceLocation | undefined,
  pidAlive: boolean | null,
  transcriptState: TranscriptPresence,
): LivenessRow {
  return {
    sessionId: entry.sessionId,
    surfaceId: entry.surfaceId,
    surfaceTitle: surface?.title ?? null,
    workspaceTitle: surface?.workspaceTitle ?? null,
    workspaceRef: surface?.workspaceRef ?? null,
    workspaceId: surface?.workspaceId ?? null,
    trackedLifecycle: entry.agentLifecycle,
    surfaceInTree: surface !== undefined,
    workspaceFocused: surface?.workspaceSelected === true,
    surfaceFocused: surface?.surfaceSelected === true,
    pidAlive,
    transcriptState,
  };
}

export function joinLiveness(tree: SurfaceTreeRead, bindings: HookBindingsRead): LivenessRead {
  const readable = tree.readable && bindings.readable;
  const revision = Math.max(tree.revision, bindings.revision);
  if (!readable) {
    return {
      live: [],
      ghosts: [],
      unboundSurfaces: [],
      focusedWorkspaceId: null,
      readable: false,
      revision,
    };
  }

  const surfaceById = new Map(tree.surfaces.map((s) => [s.surfaceId, s]));
  const boundSurfaceIds = new Set<string>();
  const live: LivenessRow[] = [];
  const ghosts: LivenessRow[] = [];

  // Live rows follow the TREE's display order so a consumer can compare against the tab bar.
  const sessionBySurface = new Map<string, HookSessionEntry>();
  for (const entry of bindings.sessions.values()) {
    if (entry.surfaceId && !sessionBySurface.has(entry.surfaceId)) {
      sessionBySurface.set(entry.surfaceId, entry);
    }
  }
  for (const surface of tree.surfaces) {
    const entry = sessionBySurface.get(surface.surfaceId);
    if (!entry) continue;
    boundSurfaceIds.add(surface.surfaceId);
    live.push(
      rowFor(
        entry,
        surface,
        bindings.pidLiveness.get(entry.sessionId) ?? null,
        bindings.transcriptPresence.get(entry.sessionId) ?? "absent",
      ),
    );
  }

  for (const entry of bindings.sessions.values()) {
    const surface = entry.surfaceId ? surfaceById.get(entry.surfaceId) : undefined;
    if (surface !== undefined) continue;
    ghosts.push(
      rowFor(
        entry,
        undefined,
        bindings.pidLiveness.get(entry.sessionId) ?? null,
        bindings.transcriptPresence.get(entry.sessionId) ?? "absent",
      ),
    );
  }

  const unboundSurfaces = tree.surfaces.filter((s) => !boundSurfaceIds.has(s.surfaceId));
  return {
    live,
    ghosts,
    unboundSurfaces,
    focusedWorkspaceId: tree.focusedWorkspaceId,
    readable: true,
    revision,
  };
}
