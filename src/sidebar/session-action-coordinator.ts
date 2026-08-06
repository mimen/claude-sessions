import type { CatalogueRow } from "../catalogue/db-schema.ts";
import type { Bridge, SurfaceLocation } from "../cmux/bridge.ts";
import { log } from "../logger.ts";
import type { AsyncProcessAdapter } from "../process/async.ts";
import type { Launcher } from "../resume/launchers.ts";
import type { ResumeSessionResult } from "../resume/resume-session.ts";
import type { SidebarResumeAction } from "../resume/sidebar-action.ts";
import type { Result } from "../result.ts";
import type { IndexedSessionInput } from "./projection.ts";

const FOCUS_TIMEOUT_MS = 3_000;
const RECENTLY_RESUMED_MS = 15_000;

export interface WorkspaceFocusTarget {
  readonly workspaceRef: string;
  readonly windowRef: string | null;
}

export type SessionFocusResult =
  | { readonly status: "focused"; readonly workspaceRef: string }
  | { readonly status: "not-live" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string };

export type SessionResumeResult =
  | { readonly status: "resumed"; readonly target: WorkspaceFocusTarget }
  | { readonly status: "already-open" }
  | { readonly status: "not-found" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "index-unreadable" }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string };

export type OpenSessionOutcome =
  | { readonly status: "focused"; readonly workspaceRef: string | null }
  | { readonly status: "resumed"; readonly workspaceRef: string | null }
  | { readonly status: "not-found" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "index-unreadable" }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string };

export type IndexedSessionLookup =
  | { readonly status: "found"; readonly row: IndexedSessionInput }
  | { readonly status: "absent" }
  | { readonly status: "unreadable"; readonly reason: string };

export interface SessionActionCoordinator {
  open(sessionId: string): Promise<OpenSessionOutcome>;
  focusWorkspace(workspaceId: string): Promise<SessionFocusResult>;
}

export interface SessionActionCoordinatorOptions {
  readonly cmuxBin: string;
  readonly now?: () => number;
  readonly recentlyResumedMs?: number;
  readonly readBridge: () => Promise<Bridge>;
  readonly lookupIndexedSession: (sessionId: string) => IndexedSessionLookup;
  readonly loadLaunchers: () => Result<readonly Launcher[]>;
  readonly resumeSession: SidebarResumeAction;
  readonly processAdapter: AsyncProcessAdapter;
  readonly paintWorkspace: (
    row: CatalogueRow,
    workspaceRef: string,
    cmuxBin: string,
    processAdapter: AsyncProcessAdapter,
  ) => Promise<void>;
  readonly defer?: (task: () => void) => void;
}

function focusTargetFromLocation(location: SurfaceLocation): WorkspaceFocusTarget {
  return { workspaceRef: location.workspaceRef, windowRef: location.windowRef };
}

export function createSessionActionCoordinator(
  options: SessionActionCoordinatorOptions,
): SessionActionCoordinator {
  const now = options.now ?? (() => Date.now());
  const recentlyResumedMs = options.recentlyResumedMs ?? RECENTLY_RESUMED_MS;
  const defer = options.defer ?? ((task: () => void) => { setTimeout(task, 0); });
  const resumeFlights = new Map<string, Promise<SessionResumeResult>>();
  const recentlyResumed = new Map<
    string,
    { readonly until: number; readonly target: WorkspaceFocusTarget }
  >();

  function identityIds(requestedId: string, row: IndexedSessionInput): readonly string[] {
    return [...new Set([requestedId, row.sessionId, row.resumeId])];
  }

  function recentTargetFor(sessionIds: readonly string[]): WorkspaceFocusTarget | null {
    const current = now();
    for (const [rememberedId, recent] of recentlyResumed) {
      if (recent.until <= current) recentlyResumed.delete(rememberedId);
    }
    for (const sessionId of sessionIds) {
      const recent = recentlyResumed.get(sessionId);
      if (recent) return recent.target;
    }
    return null;
  }

  function rememberResume(sessionIds: readonly string[], target: WorkspaceFocusTarget): void {
    const until = now() + Math.max(0, recentlyResumedMs);
    for (const sessionId of sessionIds) recentlyResumed.set(sessionId, { until, target });
  }

  function openOutcomeFromFocus(outcome: SessionFocusResult): OpenSessionOutcome {
    switch (outcome.status) {
      case "focused":
        return { status: "focused", workspaceRef: outcome.workspaceRef };
      case "liveness-unreadable":
      case "timeout":
        return outcome;
      case "not-live":
        return { status: "failed", reason: "the resolved workspace is no longer live" };
      case "failed":
        return outcome;
    }
  }

  async function focusTarget(target: WorkspaceFocusTarget): Promise<SessionFocusResult> {
    const selectArgs = ["select-workspace", "--workspace", target.workspaceRef];
    if (target.windowRef) selectArgs.push("--window", target.windowRef);
    const selected = await options.processAdapter.run(options.cmuxBin, selectArgs, {
      timeoutMs: FOCUS_TIMEOUT_MS,
    });
    if (selected.timedOut) return { status: "timeout" };
    if (!selected.ok) return { status: "failed", reason: "cmux refused to focus the workspace" };
    if (target.windowRef) {
      const focused = await options.processAdapter.run(
        options.cmuxBin,
        ["focus-window", "--window", target.windowRef],
        { timeoutMs: FOCUS_TIMEOUT_MS },
      );
      if (focused.timedOut) return { status: "timeout" };
      if (!focused.ok) return { status: "failed", reason: "cmux refused to focus the workspace" };
    }
    return { status: "focused", workspaceRef: target.workspaceRef };
  }

  function queuePaint(row: CatalogueRow | null, workspaceRef: string): void {
    if (!row) return;
    defer(() => {
      void options.paintWorkspace(
        row,
        workspaceRef,
        options.cmuxBin,
        options.processAdapter,
      ).catch((error) => {
        log.warn("sidebar deferred workspace paint failed; hooks will self-heal", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: row.sessionId,
          workspaceRef,
        });
      });
    });
  }

  async function resume(
    bridge: Bridge,
    row: IndexedSessionInput,
    sessionIds: readonly string[],
  ): Promise<SessionResumeResult> {
    const launchers = options.loadLaunchers();
    if (!launchers.ok) {
      return {
        status: "failed",
        reason: `launcher configuration could not be loaded: ${launchers.error.message}`,
      };
    }

    const resumed = await options.resumeSession({
      bridge,
      sessionId: row.sessionId,
      cmuxBin: options.cmuxBin,
      launchers: launchers.value,
    });
    if (resumed.status !== "ok") return resumed;

    const result: ResumeSessionResult = resumed.result;
    switch (result.status) {
      case "resumed": {
        if (!result.workspaceRef) {
          return { status: "failed", reason: "cmux created no addressable workspace" };
        }
        const target = { workspaceRef: result.workspaceRef, windowRef: null };
        rememberResume(sessionIds, target);
        queuePaint(resumed.paintRow, result.workspaceRef);
        return { status: "resumed", target };
      }
      case "already-open":
        return { status: "already-open" };
      case "not-indexed":
        return { status: "not-found" };
      case "liveness-unreadable":
        return { status: "liveness-unreadable" };
      default:
        return { status: "failed", reason: result.status };
    }
  }

  return {
    async focusWorkspace(workspaceId: string): Promise<SessionFocusResult> {
      const bridge = await options.readBridge();
      if (!bridge.readable) return { status: "liveness-unreadable" };
      const location = bridge.surfacesInWorkspace(workspaceId)[0];
      if (!location) return { status: "not-live" };
      return focusTarget({
        workspaceRef: location.workspaceRef,
        windowRef: location.windowRef,
      });
    },

    async open(sessionId: string): Promise<OpenSessionOutcome> {
      const bridge = await options.readBridge();
      if (!bridge.readable) return { status: "liveness-unreadable" };

      const lookup = options.lookupIndexedSession(sessionId);
      const row = lookup.status === "found" ? lookup.row : null;
      const candidates = [...new Set([sessionId, row?.sessionId, row?.resumeId].filter(
        (candidate): candidate is string => candidate !== undefined,
      ))];
      const liveLocation = candidates
        .map((candidate) => bridge.locateSession(candidate))
        .find((location): location is SurfaceLocation => location !== null);
      if (liveLocation) {
        const focused = await focusTarget(focusTargetFromLocation(liveLocation));
        return openOutcomeFromFocus(focused);
      }

      if (lookup.status === "absent") return { status: "not-found" };
      if (lookup.status === "unreadable") return { status: "index-unreadable" };
      const sessionIds = identityIds(sessionId, lookup.row);
      const recent = recentTargetFor(sessionIds);
      if (recent) {
        const focused = await focusTarget(recent);
        return openOutcomeFromFocus(focused);
      }

      const existingFlight = resumeFlights.get(lookup.row.sessionId);
      if (existingFlight) {
        const outcome = await existingFlight;
        if (outcome.status !== "resumed") {
          if (
            outcome.status === "not-found"
            || outcome.status === "liveness-unreadable"
            || outcome.status === "index-unreadable"
            || outcome.status === "catalogue-unreadable"
            || outcome.status === "timeout"
          ) return outcome;
          return {
            status: "failed",
            reason: outcome.status === "failed"
              ? outcome.reason
              : "session is already open but its workspace was not in the action's liveness read",
          };
        }
        const focused = await focusTarget(outcome.target);
        return openOutcomeFromFocus(focused);
      }

      const flight = resume(bridge, lookup.row, sessionIds);
      resumeFlights.set(lookup.row.sessionId, flight);
      try {
        const outcome = await flight;
        switch (outcome.status) {
          case "resumed":
            return { status: "resumed", workspaceRef: outcome.target.workspaceRef };
          case "not-found":
          case "liveness-unreadable":
          case "index-unreadable":
          case "catalogue-unreadable":
          case "timeout":
            return outcome;
          case "already-open":
            return {
              status: "failed",
              reason: "session is already open but its workspace was not in the action's liveness read",
            };
          case "failed":
            return outcome;
        }
      } finally {
        if (resumeFlights.get(lookup.row.sessionId) === flight) {
          resumeFlights.delete(lookup.row.sessionId);
        }
      }
    },
  };
}
