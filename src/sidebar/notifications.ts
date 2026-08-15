/**
 * Reading cmux's queued notifications.
 *
 * Live cross-checks against `cmux tree --all --json --id-format both` proved that the second UUID
 * is the workspace id: it matched `workspace.id`, while the trailing `pct:` value matched that
 * workspace's title. The third UUID matched the workspace's `panes[].surfaces[].id`.
 *
 * Parsing is separated from the CLI call so captured output stays fixture-testable. A malformed
 * non-empty line invalidates the whole snapshot rather than risking a notification-to-workspace
 * join that badges the wrong row.
 */
import { execFile } from "node:child_process";
import { createWarmCache } from "./warm-cache.ts";

const NOTIFICATION_TIMEOUT_MS = 3_000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, "i");
const INDEXED_NOTIFICATION_REGEX = new RegExp(`^(\\d+):(${UUID_PATTERN})$`, "i");

/** cmux's recognised read states, preserving an unrecognised token instead of calling it read. */
export type CmuxNotificationReadState =
  | { readonly state: "read" }
  | { readonly state: "unread" }
  | { readonly state: "unknown"; readonly token: string };

/** One queued cmux notification with the identifiers needed to open or mark it read later. */
export interface CmuxNotification {
  readonly index: number;
  readonly id: string;
  readonly workspaceId: string;
  readonly surfaceId: string;
  readonly readState: CmuxNotificationReadState;
  readonly source: string;
  readonly title: string;
  readonly body: string;
  readonly timestamp: string;
  readonly workspaceTitle: string;
}

/** A parsed notification list and its recognised unread totals by stable workspace UUID. */
export interface CmuxNotificationState {
  readonly notifications: readonly CmuxNotification[];
  readonly unreadCountsByWorkspaceId: ReadonlyMap<string, number>;
}

export type RunCmuxNotifications = (
  args: readonly string[],
  cmuxBin: string,
) => Promise<string | null>;

function emptyNotificationState(): CmuxNotificationState {
  return {
    notifications: [],
    unreadCountsByWorkspaceId: new Map<string, number>(),
  };
}

function parseReadState(token: string): CmuxNotificationReadState {
  if (token === "read") return { state: "read" };
  if (token === "unread") return { state: "unread" };
  return { state: "unknown", token };
}

function parseNotificationLine(line: string): CmuxNotification | null {
  const fields = line.split("|");
  if (fields.length !== 9) return null;

  const indexedId = fields[0];
  const workspaceId = fields[1];
  const surfaceId = fields[2];
  const readStateToken = fields[3];
  const source = fields[4];
  const title = fields[5];
  const body = fields[6];
  const timestamp = fields[7];
  const workspaceTitleField = fields[8];
  if (
    indexedId === undefined
    || workspaceId === undefined
    || surfaceId === undefined
    || readStateToken === undefined
    || source === undefined
    || title === undefined
    || body === undefined
    || timestamp === undefined
    || workspaceTitleField === undefined
  ) return null;

  const indexedIdMatch = indexedId.match(INDEXED_NOTIFICATION_REGEX);
  if (!indexedIdMatch) return null;
  const indexToken = indexedIdMatch[1];
  const id = indexedIdMatch[2];
  if (indexToken === undefined || id === undefined) return null;

  const index = Number(indexToken);
  if (!Number.isSafeInteger(index) || !UUID_REGEX.test(workspaceId) || !UUID_REGEX.test(surfaceId)) {
    return null;
  }
  if (!Number.isFinite(Date.parse(timestamp)) || !workspaceTitleField.startsWith("pct:")) {
    return null;
  }

  return {
    index,
    id,
    workspaceId,
    surfaceId,
    readState: parseReadState(readStateToken),
    source,
    title,
    body,
    timestamp,
    workspaceTitle: workspaceTitleField.slice("pct:".length),
  };
}

/**
 * Parse one complete `cmux list-notifications` output.
 *
 * Blank output is an empty list. Any malformed non-empty line makes the result empty so a partial
 * parse can never silently undercount or attach a notification to an unproven workspace id.
 */
export function parseNotifications(output: string): CmuxNotificationState {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return emptyNotificationState();

  const notifications: CmuxNotification[] = [];
  const unreadCountsByWorkspaceId = new Map<string, number>();
  for (const line of lines) {
    const notification = parseNotificationLine(line);
    if (!notification) return emptyNotificationState();
    notifications.push(notification);
    if (notification.readState.state === "unread") {
      unreadCountsByWorkspaceId.set(
        notification.workspaceId,
        (unreadCountsByWorkspaceId.get(notification.workspaceId) ?? 0) + 1,
      );
    }
  }

  return { notifications, unreadCountsByWorkspaceId };
}

const runCmux: RunCmuxNotifications = (args, cmuxBin) => {
  return new Promise((resolve) => {
    execFile(
      cmuxBin,
      [...args],
      { encoding: "utf8", timeout: NOTIFICATION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        resolve(error === null && typeof stdout === "string" ? stdout : null);
      },
    );
  });
};

/** Read all queued notifications with one subprocess, degrading every failure to empty state. */
export async function readNotifications(
  cmuxBin = "cmux",
  run: RunCmuxNotifications = runCmux,
): Promise<CmuxNotificationState> {
  try {
    const output = await run(["list-notifications"], cmuxBin);
    return output === null ? emptyNotificationState() : parseNotifications(output);
  } catch {
    return emptyNotificationState();
  }
}

export interface CachedNotificationReader {
  /** Return the warm notification state and refresh it in the background when stale. */
  read(): Promise<CmuxNotificationState>;
  /** Something authoritative said a notification changed; revalidate rather than wait out the TTL. */
  invalidate(): void;
}

/**
 * Keep the single authoritative notification read warm.
 *
 * Reads always return the current cache immediately, including an empty cache on startup. A stale
 * or missing value starts one background refresh; concurrent callers cannot pile up subprocesses.
 */
export function createCachedNotificationReader(
  cmuxBin: string,
  ttlMs: number,
  now: () => number = () => Date.now(),
  read: typeof readNotifications = readNotifications,
): CachedNotificationReader {
  const cache = createWarmCache<void, CmuxNotificationState>({
    ttlMs,
    initialValue: emptyNotificationState(),
    coldRead: "serve-initial",
    now,
    load: () => read(cmuxBin),
    failure: { type: "replace", value: emptyNotificationState },
  });
  return {
    read: () => cache.read(),
    invalidate: () => cache.invalidate(),
  };
}
