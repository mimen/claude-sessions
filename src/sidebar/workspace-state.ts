/**
 * Reading the workspace facts cmux already collects for its own sidebar.
 *
 * `cmux sidebar-state` has one key-value record per workspace. The command still costs one
 * subprocess per workspace, so callers should use the cached reader: its first read fills the
 * cache, later reads return immediately, and an expired cache refreshes once in the background.
 */
import { execFile } from "node:child_process";
import { createWarmCache } from "./warm-cache.ts";

const WORKSPACE_STATE_TIMEOUT_MS = 3_000;
const WORKSPACE_STATE_CONCURRENCY = 8;

export type WorkspacePullRequestStatus = "open" | "merged" | "closed";

export interface WorkspacePullRequest {
  readonly number: number;
  readonly status: WorkspacePullRequestStatus;
  readonly url: string;
  readonly label: string;
}

export interface WorkspaceProgress {
  readonly value: number;
  readonly label: string | null;
}

export interface WorkspaceState {
  readonly branch: string | null;
  /** True only when cmux explicitly marks the branch dirty. */
  readonly dirty: boolean;
  readonly pr: WorkspacePullRequest | null;
  readonly ports: readonly number[];
  readonly progress: WorkspaceProgress | null;
  readonly color: string | null;
  readonly cwd: string;
}

export type RunCmuxWorkspaceState = (
  args: readonly string[],
  cmuxBin: string,
) => Promise<string | null>;

function topLevelFields(output: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const rawLine of output.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) continue;
    // Status, metadata, and log rows are indented below their count fields.
    if (/^\s/.test(line)) continue;

    const equalsAt = line.indexOf("=");
    if (equalsAt <= 0) return null;
    const key = line.slice(0, equalsAt);
    if (fields.has(key)) return null;
    fields.set(key, line.slice(equalsAt + 1));
  }
  return fields;
}

function parseBranch(raw: string): Pick<WorkspaceState, "branch" | "dirty"> | null {
  if (raw === "none") return { branch: null, dirty: false };

  const dirtySuffix = " dirty";
  const cleanSuffix = " clean";
  const dirty = raw.endsWith(dirtySuffix);
  const clean = raw.endsWith(cleanSuffix);
  const branch = dirty
    ? raw.slice(0, -dirtySuffix.length)
    : clean
      ? raw.slice(0, -cleanSuffix.length)
      : raw;

  // Current cmux emits an explicit clean/dirty suffix. Accepting a bare branch keeps the reader
  // compatible with the earlier shape where only dirty branches carried a suffix.
  if (!branch || /\s/.test(branch)) return null;
  return { branch, dirty };
}

function validHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parsePullRequest(raw: string, label: string): WorkspacePullRequest | null {
  const match = /^#([1-9]\d*) (open|merged|closed) (\S+)$/.exec(raw);
  if (!match) return null;

  const numberRaw = match[1];
  const statusRaw = match[2];
  const url = match[3];
  if (
    !numberRaw
    || (statusRaw !== "open" && statusRaw !== "merged" && statusRaw !== "closed")
    || !url
    || !label
    || !validHttpUrl(url)
  ) return null;

  const number = Number(numberRaw);
  if (!Number.isSafeInteger(number)) return null;
  const status: WorkspacePullRequestStatus = statusRaw;
  return { number, status, url, label };
}

function parsePorts(raw: string): readonly number[] | null {
  if (raw === "none") return [];
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) return null;

  const ports = raw.split(",").map(Number);
  return ports.every((port) => Number.isInteger(port) && port <= 65_535) ? ports : null;
}

function parseProgress(raw: string): WorkspaceProgress | null | undefined {
  if (raw === "none") return null;

  const match = /^(\d+\.\d{2})(?: (.+))?$/.exec(raw);
  if (!match) return undefined;
  const valueRaw = match[1];
  if (!valueRaw) return undefined;

  const value = Number(valueRaw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return undefined;
  return { value, label: match[2] ?? null };
}

/** Parse one complete `cmux sidebar-state` response, or null when its fields are malformed. */
export function parseWorkspaceState(output: string): WorkspaceState | null {
  const fields = topLevelFields(output);
  if (!fields) return null;

  const colorRaw = fields.get("color");
  const cwd = fields.get("cwd");
  const branchRaw = fields.get("git_branch");
  const pullRequestRaw = fields.get("pr");
  const pullRequestLabel = fields.get("pr_label");
  const portsRaw = fields.get("ports");
  const progressRaw = fields.get("progress");
  if (
    colorRaw === undefined
    || cwd === undefined
    || branchRaw === undefined
    || pullRequestRaw === undefined
    || pullRequestLabel === undefined
    || portsRaw === undefined
    || progressRaw === undefined
    || colorRaw.length === 0
    || cwd.length === 0
  ) return null;

  const branch = parseBranch(branchRaw);
  if (!branch) return null;

  let pr: WorkspacePullRequest | null;
  if (pullRequestRaw === "none") {
    if (pullRequestLabel !== "none") return null;
    pr = null;
  } else {
    pr = parsePullRequest(pullRequestRaw, pullRequestLabel);
    if (!pr) return null;
  }

  const ports = parsePorts(portsRaw);
  const progress = parseProgress(progressRaw);
  if (!ports || progress === undefined) return null;

  return {
    ...branch,
    pr,
    ports,
    progress,
    color: colorRaw === "none" ? null : colorRaw,
    cwd,
  };
}

const runCmux: RunCmuxWorkspaceState = (args, cmuxBin) => {
  return new Promise((resolve) => {
    execFile(cmuxBin, [...args], {
      encoding: "utf8",
      timeout: WORKSPACE_STATE_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout) => {
      resolve(error === null && typeof stdout === "string" ? stdout : null);
    });
  });
};

/**
 * Read the sidebar state for each stable workspace UUID with bounded concurrency.
 *
 * Every requested UUID receives a map entry. A failed command or malformed response becomes null,
 * and neither failure is allowed to reject the fleet read.
 */
export async function readWorkspaceStates(
  workspaceIds: readonly string[],
  cmuxBin = "cmux",
  run: RunCmuxWorkspaceState = runCmux,
): Promise<Map<string, WorkspaceState | null>> {
  const states = new Map<string, WorkspaceState | null>();
  const queue = [...new Set(workspaceIds)];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const workspaceId = queue[cursor];
      cursor += 1;
      if (!workspaceId) continue;

      try {
        const output = await run(["sidebar-state", "--workspace", workspaceId], cmuxBin);
        states.set(workspaceId, output === null ? null : parseWorkspaceState(output));
      } catch {
        states.set(workspaceId, null);
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(WORKSPACE_STATE_CONCURRENCY, queue.length) },
    () => worker(),
  ));
  return states;
}

export interface CachedWorkspaceStateReader {
  /** Cached workspace states, refreshing in the background once they age past the TTL. */
  read(workspaceIds: readonly string[]): Promise<Map<string, WorkspaceState | null>>;
  /** Something authoritative said a workspace changed; revalidate rather than wait out the TTL. */
  invalidate(): void;
}

function nullStates(workspaceIds: readonly string[]): Map<string, WorkspaceState | null> {
  return new Map([...new Set(workspaceIds)].map((workspaceId) => [workspaceId, null]));
}

function completeStates(
  workspaceIds: readonly string[],
  states: Map<string, WorkspaceState | null>,
): Map<string, WorkspaceState | null> {
  const complete = new Map<string, WorkspaceState | null>();
  for (const workspaceId of new Set(workspaceIds)) {
    complete.set(workspaceId, states.get(workspaceId) ?? null);
  }
  return complete;
}

/**
 * Keep cmux's per-workspace sidebar state warm without putting its subprocess sweep on every poll.
 *
 * The first call waits because there is no truthful value to serve. Later calls return the last
 * complete sweep immediately. Once stale, one refresh starts in the background; concurrent reads
 * share it instead of piling up more cmux processes.
 */
export function createCachedWorkspaceStateReader(
  cmuxBin: string,
  ttlMs: number,
  now: () => number = () => Date.now(),
  read: typeof readWorkspaceStates = readWorkspaceStates,
  onReplaced?: () => void,
): CachedWorkspaceStateReader {
  const cache = createWarmCache<readonly string[], Map<string, WorkspaceState | null>>({
    ttlMs,
    initialValue: new Map<string, WorkspaceState | null>(),
    coldRead: "block",
    now,
    load: async (workspaceIds) => {
      const requested = [...new Set(workspaceIds)];
      return completeStates(requested, await read(requested, cmuxBin));
    },
    failure: { type: "replace", value: nullStates },
    ...(onReplaced ? { onReplaced } : {}),
  });
  return {
    read: (workspaceIds) => cache.read(workspaceIds),
    invalidate: () => cache.invalidate(),
  };
}
