/**
 * Reading cmux's own `claude_code` status pill.
 *
 * cmux owns the vocabulary, the icon, and the color; this module only parses what
 * `cmux list-status` prints so the sidebar can reproduce it rather than invent a parallel
 * status model. Parsing is separated from the CLI call so it stays fixture-testable.
 */
import { execFile } from "node:child_process";
import type { CmuxClaudeStatus } from "./projection.ts";
import { createWarmCache } from "./warm-cache.ts";

const STATUS_TIMEOUT_MS = 3_000;
/** How many `cmux list-status` calls may be in flight at once. */
const STATUS_CONCURRENCY = 8;

/** The three truthful outcomes of asking cmux for one workspace's Claude status. */
export type CmuxStatusRead =
  | { readonly state: "published"; readonly status: CmuxClaudeStatus }
  /** Inferred from the hook store while an authoritative sweep is pending. */
  | { readonly state: "derived"; readonly status: CmuxClaudeStatus }
  | { readonly state: "absent" }
  | { readonly state: "unreadable" };

export type RunCmuxStatus = (
  args: readonly string[],
  cmuxBin: string,
) => Promise<string | null>;

/**
 * Parse one `cmux list-status` output.
 *
 * The shipped format is `key=value icon=<name> color=<hex>` per line. Values can contain
 * spaces ("Needs input"), so each attribute is read up to the next recognized key.
 */
export function parseClaudeStatus(output: string): CmuxClaudeStatus | null {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("claude_code=")) continue;

    const body = trimmed.slice("claude_code=".length);
    const iconAt = body.search(/\s(?:icon|color)=/);
    const label = (iconAt >= 0 ? body.slice(0, iconAt) : body).trim();
    if (!label) return null;

    const icon = body.match(/\bicon=(\S+)/)?.[1] ?? null;
    const color = body.match(/\bcolor=(\S+)/)?.[1] ?? null;
    return { label, icon, color };
  }
  return null;
}

const runCmux: RunCmuxStatus = (args, cmuxBin) => {
  return new Promise((resolve) => {
    execFile(cmuxBin, [...args], { encoding: "utf8", timeout: STATUS_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      resolve(error === null && typeof stdout === "string" ? stdout : null);
    });
  });
};

/**
 * Read the `claude_code` status for each stable workspace UUID, bounded so a large fleet does not
 * fan out into dozens of simultaneous cmux calls. Every requested workspace gets an entry so an
 * absent status remains distinguishable from a command we could not read.
 */
export async function readClaudeStatuses(
  workspaceIds: readonly string[],
  cmuxBin = "cmux",
  run: RunCmuxStatus = runCmux,
): Promise<Map<string, CmuxStatusRead>> {
  const statuses = new Map<string, CmuxStatusRead>();
  const queue = [...new Set(workspaceIds)];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const workspaceId = queue[cursor];
      cursor += 1;
      if (!workspaceId) continue;
      const output = await run(["list-status", "--workspace", workspaceId], cmuxBin);
      if (output === null) {
        statuses.set(workspaceId, { state: "unreadable" });
        continue;
      }
      const status = parseClaudeStatus(output);
      statuses.set(
        workspaceId,
        status ? { state: "published", status } : { state: "absent" },
      );
    }
  }

  const workers = Array.from(
    { length: Math.min(STATUS_CONCURRENCY, queue.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return statuses;
}

/**
 * The hook store's own view of a session's state.
 *
 * `cmux list-status` is authoritative but costs one subprocess per workspace — measured at 503ms
 * across 19 workspaces, which was 90% of a snapshot. The hook store carries the same state and
 * arrives for free with the bridge, so it fills the gap between authoritative reads. It is not a
 * substitute: sampled live, `needsInput` and `running` matched the pill exactly, but two
 * workspaces reported `unknown` while cmux published "Running". So this is labelled `derived`
 * and the real read corrects it.
 */
export function statusFromAgentLifecycle(agentLifecycle: string | null): CmuxClaudeStatus | null {
  switch (agentLifecycle) {
    case "running":
      return { label: "Running", icon: null, color: null };
    case "needsInput":
      return { label: "Needs input", icon: null, color: null };
    default:
      return null;
  }
}

export interface CachedStatusReader {
  /** Cached statuses, refreshing in the background once they age past the TTL. */
  read(workspaceIds: readonly string[]): Promise<Map<string, CmuxStatusRead>>;
  /** Something authoritative said a status changed; revalidate rather than wait out the TTL. */
  invalidate(): void;
}

/**
 * Keep the authoritative statuses warm.
 *
 * The cold read waits for the first truthful sweep. Warm reads get the last result immediately and
 * kick an expired refresh into the background. One sweep runs at a time, so a slow cmux cannot
 * pile up work.
 */
export function createCachedStatusReader(
  cmuxBin: string,
  ttlMs: number,
  now: () => number = () => Date.now(),
  read: typeof readClaudeStatuses = readClaudeStatuses,
  onReplaced?: () => void,
): CachedStatusReader {
  const cache = createWarmCache<readonly string[], Map<string, CmuxStatusRead>>({
    ttlMs,
    initialValue: new Map<string, CmuxStatusRead>(),
    coldRead: "block",
    now,
    load: (workspaceIds) => read(workspaceIds, cmuxBin),
    // An authoritative read failure must not erase the last truthful status. Leaving it stale makes
    // the next read retry rather than treating a failed attempt as a fresh observation.
    failure: { type: "retain-and-retry" },
    ...(onReplaced ? { onReplaced } : {}),
  });
  return {
    read: (workspaceIds) => cache.read(workspaceIds),
    invalidate: () => cache.invalidate(),
  };
}
