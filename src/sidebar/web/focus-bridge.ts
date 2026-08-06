/**
 * The native focus bridge.
 *
 * When the sidebar page is hosted inside cmux's own web view, cmux installs a WebKit message
 * handler that focuses a workspace in-process. Taking it saves the whole HTTP round trip on the
 * one action that happens most: clicking a row to go look at it.
 *
 * Everything here is written for a bridge that may not exist, may be an older build, or may
 * answer with something this page does not recognize. Every one of those is a fall-through to the
 * HTTP action that already works, never an error the user has to read: the click still focuses,
 * only a few milliseconds later.
 */

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/** How long a native reply may take before the HTTP path is used instead. */
export const FOCUS_BRIDGE_TIMEOUT_MS = 1_000;

/** The wire version this page speaks. A reply carrying any other version is not understood. */
const FOCUS_BRIDGE_VERSION = 1;

/** The single message this page ever posts to the host. */
export interface FocusBridgeRequest {
  readonly v: typeof FOCUS_BRIDGE_VERSION;
  readonly workspaceId: string;
}

/**
 * The host's reply is ordinary JSON crossing a process boundary, so it is typed as JSON and
 * validated, not asserted. `postMessage` is declared here because no DOM lib describes it.
 */
export interface CmuxFocusMessageHandler {
  readonly postMessage: (message: FocusBridgeRequest) => Promise<JsonValue>;
}

export interface CmuxMessageHandlers {
  readonly cmuxSidebarFocusWorkspace?: CmuxFocusMessageHandler;
}

export interface CmuxWebkitBridge {
  readonly messageHandlers?: CmuxMessageHandlers;
}

declare global {
  interface Window {
    /** Present only inside cmux's web view; a plain browser tab has none. */
    readonly webkit?: CmuxWebkitBridge;
  }
}

/**
 * What the bridge did.
 *
 * `focused` is the only outcome that means the workspace is now on screen. The rest name why it
 * is not, and are kept apart because they are different bugs to chase, not because the UI shows
 * them: every one of them falls through to HTTP identically.
 */
export type FocusBridgeOutcome =
  /** The host confirmed the workspace is focused. */
  | "focused"
  /** No handler is installed: an ordinary browser tab, or a cmux build without the bridge. */
  | "no-bridge"
  /** The host knows the bridge but not this workspace id. */
  | "not-found"
  /** The host declined to act right now. */
  | "unavailable"
  /** `postMessage` threw or its promise rejected. */
  | "rejected"
  /** No reply within the deadline. */
  | "timeout"
  /** A reply arrived, but not one this page understands. */
  | "malformed-reply";

export interface FocusBridgeOptions {
  /** Overrides the ambient host lookup; tests pass a stub instead of touching a global. */
  readonly bridge?: CmuxWebkitBridge | null;
  readonly timeoutMs?: number;
}

const FOCUS_BRIDGE_TIMEOUT: unique symbol = Symbol("focus-bridge-timeout");

function ambientBridge(): CmuxWebkitBridge | null {
  return typeof window === "undefined" ? null : window.webkit ?? null;
}

function resolveHandler(options: FocusBridgeOptions): CmuxFocusMessageHandler | null {
  const bridge = options.bridge === undefined ? ambientBridge() : options.bridge;
  const handler = bridge?.messageHandlers?.cmuxSidebarFocusWorkspace;
  if (!handler || typeof handler.postMessage !== "function") return null;
  return handler;
}

/**
 * Read one reply.
 *
 * Strict on purpose: the version must be the one this page speaks and the status must be one of
 * the three it knows. A reply that is close but not exact is a mismatched host, and guessing at
 * its meaning would be how a click silently stops focusing anything.
 */
function readReply(reply: JsonValue): FocusBridgeOutcome {
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
    return "malformed-reply";
  }
  const envelope = reply as JsonObject;
  if (envelope["v"] !== FOCUS_BRIDGE_VERSION) return "malformed-reply";
  const status = envelope["status"];
  if (status === "focused" || status === "not-found" || status === "unavailable") return status;
  return "malformed-reply";
}

/** Ask the host to focus one workspace. Never throws; every failure is an outcome. */
export async function requestCmuxFocus(
  workspaceId: string,
  options: FocusBridgeOptions = {},
): Promise<FocusBridgeOutcome> {
  const handler = resolveHandler(options);
  if (handler === null) return "no-bridge";

  const timeoutMs = options.timeoutMs ?? FOCUS_BRIDGE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FOCUS_BRIDGE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(FOCUS_BRIDGE_TIMEOUT), Math.max(0, timeoutMs));
  });

  try {
    // A synchronous throw from `postMessage` is the same failure as a rejected promise: the host
    // did not act, so the HTTP path has to.
    let call: Promise<JsonValue>;
    try {
      call = Promise.resolve(handler.postMessage({ v: FOCUS_BRIDGE_VERSION, workspaceId }));
    } catch {
      return "rejected";
    }

    let reply: JsonValue | typeof FOCUS_BRIDGE_TIMEOUT;
    try {
      reply = await Promise.race([call, deadline]);
    } catch {
      return "rejected";
    }
    return reply === FOCUS_BRIDGE_TIMEOUT ? "timeout" : readReply(reply);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** What a row needs to be addressable by the bridge; the full row type is more than this asks. */
export interface FocusBridgeRow {
  readonly workspaceId: string | null;
}

export type FocusRowFallback<T> =
  | { readonly performed: false }
  | { readonly performed: true; readonly value: T };

export interface FocusRowResult<T> {
  readonly outcome: FocusBridgeOutcome;
  readonly fallback: FocusRowFallback<T>;
}

/**
 * Focus one row, natively when possible and over HTTP otherwise.
 *
 * The fallback runs at most once and only when the bridge did not focus, so a native focus costs
 * zero requests and every other path behaves exactly as it did before the bridge existed. A row
 * with no workspace has no native address at all, so it goes straight to HTTP without a message.
 */
export async function focusWorkspaceRow<T>(
  row: FocusBridgeRow,
  fallback: () => Promise<T>,
  options: FocusBridgeOptions = {},
): Promise<FocusRowResult<T>> {
  const outcome = row.workspaceId === null
    ? "no-bridge"
    : await requestCmuxFocus(row.workspaceId, options);
  if (outcome === "focused") return { outcome, fallback: { performed: false } };
  return { outcome, fallback: { performed: true, value: await fallback() } };
}
