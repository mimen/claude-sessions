/**
 * Primitive 4 — agent activity: the Running / Needs input / idle picture per workspace.
 *
 * Two sources, layered:
 *   - authoritative: cmux's own `claude_code` pill (`cmux list-status`), one subprocess per
 *     workspace — truthful but expensive;
 *   - derived: the hook store's `agentLifecycle`, free with the bridge, correct for
 *     running/needsInput but blind for some states — a fill-in, never a substitute.
 *
 * Published wins; derived fills the gap; absent/unreadable stay honestly labelled. On a sweep
 * where every workspace came back unreadable, the last trustworthy map is retained with its
 * revision frozen — a failed read must never look like a change, and a stale pill beats a blank
 * one. Revision advances only when the effective picture actually changed on a readable sweep.
 */
import type { CmuxStatusRead } from "../status.ts";
import type { CmuxClaudeStatus } from "../projection.ts";
import { statusFromAgentLifecycle } from "../status.ts";

export interface ActivityObservation {
  readonly workspaceId: string;
  readonly agentLifecycle: string | null;
}

export type EffectiveActivity =
  | { readonly state: "published" | "derived"; readonly status: CmuxClaudeStatus }
  | { readonly state: "absent" | "unreadable"; readonly status: null };

export interface AgentActivityRead {
  readonly byWorkspace: ReadonlyMap<string, EffectiveActivity>;
  readonly revision: number;
}

export interface AgentActivityIo {
  /** One authoritative sweep over the given workspace ids. Never throws; per-id failures are unreadable entries. */
  sweep(workspaceIds: readonly string[]): Promise<ReadonlyMap<string, CmuxStatusRead>>;
}

export function createAgentActivityReader(
  io: AgentActivityIo,
): { read(observations: readonly ActivityObservation[]): Promise<AgentActivityRead> } {
  let revision = 0;
  let lastIdentity: string | null = null;
  let lastGood: ReadonlyMap<string, EffectiveActivity> = new Map();

  function identityOf(map: ReadonlyMap<string, EffectiveActivity>): string {
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, e]) => `${id}:${e.state}:${e.status?.label ?? ""}`)
      .join("|");
  }

  return {
    async read(observations: readonly ActivityObservation[]): Promise<AgentActivityRead> {
      const workspaceIds = [...new Set(observations.map((o) => o.workspaceId))];
      const sweep = await io.sweep(workspaceIds);
      const byWorkspace = new Map<string, EffectiveActivity>();
      for (const o of observations) {
        const read = sweep.get(o.workspaceId) ?? { state: "unreadable" as const };
        if (read.state === "published" || read.state === "derived") {
          byWorkspace.set(o.workspaceId, { state: read.state, status: read.status });
          continue;
        }
        const derived = statusFromAgentLifecycle(o.agentLifecycle);
        byWorkspace.set(
          o.workspaceId,
          derived ? { state: "derived", status: derived } : { state: read.state, status: null },
        );
      }

      const anyReadable = [...byWorkspace.values()].some((e) => e.state !== "unreadable");
      if (!anyReadable && byWorkspace.size > 0) {
        // Total sweep failure: retain the last trustworthy picture, revision frozen.
        return { byWorkspace: lastGood, revision };
      }

      const identity = identityOf(byWorkspace);
      if (identity !== lastIdentity) {
        revision += 1;
        lastIdentity = identity;
      }
      lastGood = byWorkspace;
      return { byWorkspace, revision };
    },
  };
}
