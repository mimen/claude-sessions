/**
 * Primitive 7 — workspace extras: the per-workspace facts that decorate rows.
 *
 * Composes two independent sources into one read:
 *   - unread notification counts (one cheap cmux call covers every workspace);
 *   - workspace state (branch, cwd, PR, ports — one subprocess per workspace, so callers
 *     pass only the workspaces they will actually render).
 *
 * The underlying cached readers own retention: a failed notification read degrades to an
 * empty map, a failed state read to nulls, and both keep their last good values rather than
 * erasing them. This primitive's job is the composition and the revision — which advances
 * only when the composed picture (unread counts, branch/dirty/PR) actually changed.
 */
import type { CmuxNotificationState } from "../notifications.ts";
import type { WorkspaceState } from "../workspace-state.ts";

export interface WorkspaceExtrasRead {
  readonly unreadByWorkspaceId: ReadonlyMap<string, number>;
  readonly stateByWorkspaceId: ReadonlyMap<string, WorkspaceState | null>;
  readonly revision: number;
}

export interface WorkspaceExtrasIo {
  readNotifications(): Promise<CmuxNotificationState>;
  readWorkspaceStates(
    workspaceIds: readonly string[],
  ): Promise<ReadonlyMap<string, WorkspaceState | null>>;
}

export function createWorkspaceExtrasReader(io: WorkspaceExtrasIo): {
  read(workspaceIds: readonly string[]): Promise<WorkspaceExtrasRead>;
} {
  let revision = 0;
  let lastIdentity: string | null = null;

  function identityOf(
    unread: ReadonlyMap<string, number>,
    states: ReadonlyMap<string, WorkspaceState | null>,
  ): string {
    const unreadPart = [...unread.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, n]) => `${id}=${n}`)
      .join(",");
    const statePart = [...states.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, s]) => `${id}:${s?.branch ?? ""}:${s?.dirty ? "d" : ""}:${s?.pr?.label ?? ""}:${(s?.ports ?? []).join(".")}`)
      .join(";");
    return `${unreadPart}|${statePart}`;
  }

  return {
    async read(workspaceIds: readonly string[]): Promise<WorkspaceExtrasRead> {
      const [notifications, states] = await Promise.all([
        io.readNotifications(),
        workspaceIds.length > 0
          ? io.readWorkspaceStates(workspaceIds)
          : Promise.resolve(new Map<string, WorkspaceState | null>()),
      ]);
      const unread = notifications.unreadCountsByWorkspaceId;
      const identity = identityOf(unread, states);
      if (identity !== lastIdentity) {
        revision += 1;
        lastIdentity = identity;
      }
      return { unreadByWorkspaceId: unread, stateByWorkspaceId: states, revision };
    },
  };
}
