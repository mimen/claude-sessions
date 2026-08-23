/**
 * Listen to cmux instead of asking it.
 *
 * Every cached source in the sidebar carries a TTL, and a TTL is a guess about when a value stopped
 * being true. The guesses are why acting on a session could take seconds to show: closing a
 * workspace changed the world instantly and the sidebar went on serving the world it had until an
 * arbitrary window elapsed. Worse, the windows differ per source, so one response could carry a
 * fresh tree and a ten-second-old workspace state — which is how a row came to be drawn open after
 * it closed.
 *
 * cmux already publishes the answer. `cmux events` is a sequenced, replayable stream of everything
 * that happens to windows, workspaces, surfaces and agents, so the sidebar can be told what changed
 * rather than re-reading on a timer and hoping. This module turns that stream into the only thing
 * the caches need to hear: which of them is now out of date.
 *
 * It is deliberately an invalidator and not a source of truth. Frames say *that* something changed;
 * the existing readers still say *what* it changed to. That keeps one projection rather than two
 * that can disagree, and it means a missed or unknown frame degrades to the TTL behaviour that
 * exists today rather than to a wrong answer.
 */
import { log } from "../logger.ts";

/** Which cached source a frame invalidates. */
export type CmuxChangeScope =
  /** The cmux tree: which windows, workspaces and surfaces exist, and where sessions sit in them. */
  | "liveness"
  /** The agent status pill for a workspace. */
  | "status"
  /** Branch, PR, ports and cwd for a workspace. */
  | "workspaceState"
  /** Unread counts and notification state. */
  | "notifications";

export interface CmuxEventSubscription {
  stop(): void;
}

/** One running `cmux events` process, reduced to the things a subscriber needs. */
export interface CmuxEventStreamProcess {
  /** Complete NDJSON lines, in order, until the process ends. */
  readonly lines: AsyncIterable<string>;
  kill(): void;
  /** Whatever the process wrote to stderr, for explaining a stream that ended silently. */
  stderrTail?(): string;
}

export interface CmuxEventStreamIo {
  spawn(cmuxBin: string, args: readonly string[]): CmuxEventStreamProcess;
}

export interface CmuxEventSubscriptionOptions {
  readonly cmuxBin?: string;
  /**
   * Called with everything one frame invalidated. Never called with an empty set.
   *
   * Coalescing belongs to the caller: what counts as "too often" depends on what it does with the
   * news, and a subscription that decided for it would have to be undone by anything wanting
   * different behaviour.
   */
  readonly onChange: (scopes: ReadonlySet<CmuxChangeScope>) => void;
  /**
   * Optional raw frame, so a caller that can do a scoped refresh (one workspace's
   * status pill) is not forced into a fleet-wide sweep.
   */
  readonly onFrame?: (frame: unknown, scopes: ReadonlySet<CmuxChangeScope>) => void;
  readonly io?: CmuxEventStreamIo;
  readonly logger?: Pick<typeof log, "warn" | "info">;
  /** Test seam for the respawn backoff, which is otherwise measured in seconds. */
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Backoff for respawning a subscription that ended.
 *
 * cmux reconnects to its own socket on its own, so a process that exits means something larger:
 * cmux is not running, the binary predates `cmux events`, or the socket moved. None of those are
 * fixed by trying hard, and the sidebar keeps working without the stream, so the ceiling is
 * generous rather than eager.
 */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 15_000, 30_000] as const;

/**
 * What each category of frame makes out of date.
 *
 * Keyed on category rather than event name on purpose: names are numerous and cmux adds them, and a
 * mapping that has to be extended for every new name would quietly stop covering the thing it
 * exists to cover. Categories are few and stable.
 */
const SCOPES_BY_CATEGORY: Readonly<Record<string, readonly CmuxChangeScope[]>> = {
  /** Windows come and go, and the tree names which one is active. */
  window: ["liveness"],
  /** A workspace changing covers both where it sits in the tree and its branch, PR and ports. */
  workspace: ["liveness", "workspaceState"],
  /** cmux publishes the agent's own status pill under this category. */
  sidebar: ["status"],
  notification: ["notifications"],
};

/**
 * Agent frames worth listening to.
 *
 * The category is dominated by per-tool hooks — `agent.hook.PreToolUse` alone was a third of a
 * sampled minute — and none of them move a session between surfaces. Status changes arrive
 * separately as `sidebar.metadata.updated`, so listening to the whole category would be mostly
 * noise invalidating caches nothing had changed. These four are the ones that rebind a session.
 */
const AGENT_LIVENESS_EVENTS: ReadonlySet<string> = new Set([
  "agent.hook.SessionStart",
  "agent.hook.SessionEnd",
  "agent.start",
  "agent.end",
]);

/** Frames whose only content is a duplicate of an agent frame we already handle. */
const IGNORED_CATEGORIES: ReadonlySet<string> = new Set(["feed"]);

interface EventFrame {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly category?: unknown;
  readonly resume?: { readonly gap?: unknown };
}

/**
 * Best-effort workspace id or ref on a cmux event frame.
 * Frames are not a documented schema; missing fields just mean "refresh all".
 */
export function workspaceIdFromFrame(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  const record = frame as Record<string, unknown>;
  const direct = pickWorkspaceToken(record);
  if (direct) return direct;
  for (const nested of ["payload", "data", "workspace", "target"]) {
    const value = record[nested];
    if (typeof value === "object" && value !== null) {
      const inner = pickWorkspaceToken(value as Record<string, unknown>);
      if (inner) return inner;
    }
  }
  return null;
}

function pickWorkspaceToken(record: Record<string, unknown>): string | null {
  for (const key of ["workspace_id", "workspaceId", "workspace_ref", "workspaceRef"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** What one frame invalidates, or null if it changes nothing the sidebar shows. */
export function scopesForFrame(frame: unknown): ReadonlySet<CmuxChangeScope> | null {
  if (typeof frame !== "object" || frame === null) return null;
  const { type, name, category } = frame as EventFrame;
  if (type !== "event") return null;
  if (typeof category !== "string" || IGNORED_CATEGORIES.has(category)) return null;

  if (category === "agent") {
    if (typeof name !== "string" || !AGENT_LIVENESS_EVENTS.has(name)) return null;
    return new Set<CmuxChangeScope>(["liveness", "status"]);
  }

  const scopes = SCOPES_BY_CATEGORY[category];
  return scopes === undefined ? null : new Set(scopes);
}

/**
 * A gap means retained events were dropped before we read them, so some change went unseen.
 *
 * The honest response is to assume everything is stale rather than to reason about what might have
 * been missed. It costs one round of reads and is what makes the stream safe to depend on.
 */
const EVERY_SCOPE: ReadonlySet<CmuxChangeScope> = new Set<CmuxChangeScope>([
  "liveness",
  "status",
  "workspaceState",
  "notifications",
]);

function resumeGapped(frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  const { type, resume } = frame as EventFrame;
  if (type !== "ack") return false;
  return typeof resume === "object" && resume !== null && resume.gap === true;
}

const STDERR_TAIL_LIMIT = 2_000;

const bunEventStreamIo: CmuxEventStreamIo = {
  spawn(cmuxBin, args) {
    const child = Bun.spawn([cmuxBin, ...args], { stdout: "pipe", stderr: "pipe" });
    // A stream that exits without frames only explains itself on stderr, so keep a bounded tail.
    let stderrTail = "";
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_LIMIT);
      }
    })().catch(() => {});
    return {
      lines: readLines(child.stdout),
      kill: () => child.kill(),
      stderrTail: () => stderrTail.trim(),
    };
  },
};

/** Split a byte stream into complete lines, holding a partial tail until the rest arrives. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) yield line;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer;
}

/**
 * Follow cmux for as long as the caller wants to hear about it.
 *
 * `--reconnect` is cmux's own resumption across socket drops, which is finer-grained than
 * respawning: it resumes from the last sequence it delivered, so a brief drop loses nothing. The
 * respawn loop here is for the coarser failure of the process itself ending.
 *
 * Heartbeats are left on. They cost one frame every fifteen seconds and are the only evidence that
 * a silent stream is healthy rather than wedged.
 */
export function subscribeToCmuxEvents(
  options: CmuxEventSubscriptionOptions,
): CmuxEventSubscription {
  const cmuxBin = options.cmuxBin ?? "cmux";
  const io = options.io ?? bunEventStreamIo;
  const logger = options.logger ?? log;
  const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let stopped = false;
  let current: CmuxEventStreamProcess | null = null;
  let warnedUnavailable = false;

  /** @returns whether the stream produced anything at all, which is how support is detected. */
  async function runOnce(): Promise<{ sawOutput: boolean; stderr: string }> {
    const child = io.spawn(cmuxBin, ["events", "--reconnect"]);
    current = child;
    let sawOutput = false;
    const outcome = (): { sawOutput: boolean; stderr: string } => ({
      sawOutput,
      stderr: child.stderrTail?.() ?? "",
    });
    try {
      for await (const line of child.lines) {
        sawOutput = true;
        if (stopped) return outcome();
        let frame: unknown;
        try {
          frame = JSON.parse(line);
        } catch {
          // A malformed line is not worth ending a healthy stream over.
          continue;
        }
        if (resumeGapped(frame)) {
          logger.warn("cmux event stream resumed with a gap; revalidating everything", {});
          options.onChange(EVERY_SCOPE);
          continue;
        }
        const scopes = scopesForFrame(frame);
        if (scopes !== null) {
          options.onChange(scopes);
          options.onFrame?.(frame, scopes);
        }
      }
      return outcome();
    } finally {
      if (current === child) current = null;
    }
  }

  function warnUnavailableOnce(reason: string, stderr = ""): void {
    if (warnedUnavailable) return;
    warnedUnavailable = true;
    // Once, not per attempt: a cmux that predates `cmux events` would otherwise fill the log with
    // a fact that does not change, and the sidebar is still correct without the stream.
    logger.warn("cmux event stream unavailable; falling back to timed reads", {
      reason,
      ...(stderr ? { stderr } : {}),
    });
  }

  async function supervise(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      try {
        // A stream that ends without ever emitting a frame is how a cmux without `events` — or one
        // that is not running — presents itself. It exits cleanly, so only stderr can say why.
        const result = await runOnce();
        if (!result.sawOutput) warnUnavailableOnce("stream produced no frames", result.stderr);
      } catch (error) {
        warnUnavailableOnce(error instanceof Error ? error.message : String(error));
      }
      if (stopped) return;
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 30_000;
      attempt += 1;
      await sleep(delay);
    }
  }

  void supervise();

  return {
    stop(): void {
      stopped = true;
      current?.kill();
      current = null;
    },
  };
}
