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

/**
 * Why an action refused, from a closed vocabulary the client may show verbatim.
 *
 * Separate from a failure's `reason`, which is free text and can carry paths or database errors,
 * so it never leaves the server. These name conditions a person can act on — and, mostly, cannot
 * fix by retrying, which is what the generic "refresh the list and try again" wrongly implied.
 */
export type ActionRefusal =
  | "route-ineligible"
  | "unknown-launcher"
  | "launcher-env-unresolvable"
  | "spawn-failed"
  | "cwd-unreadable"
  | "reactivation-failed"
  | "t3-confirmation-required";

export type SessionResumeResult =
  | { readonly status: "resumed"; readonly target: WorkspaceFocusTarget }
  | { readonly status: "already-open" }
  | { readonly status: "not-found" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "index-unreadable" }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string; readonly refusal?: ActionRefusal };

export type OpenSessionOutcome =
  | { readonly status: "focused"; readonly workspaceRef: string | null }
  | { readonly status: "resumed"; readonly workspaceRef: string | null }
  | { readonly status: "not-found" }
  | { readonly status: "liveness-unreadable" }
  | { readonly status: "index-unreadable" }
  | { readonly status: "catalogue-unreadable" }
  | { readonly status: "timeout" }
  | { readonly status: "failed"; readonly reason: string; readonly refusal?: ActionRefusal };

export type IndexedSessionLookup =
  | { readonly status: "found"; readonly row: IndexedSessionInput }
  | { readonly status: "absent" }
  | { readonly status: "unreadable"; readonly reason: string };

export interface OpenSessionOptions {
  /** The user confirmed reopening a completed session: clear Completed as part of the resume. */
  readonly reopenCompleted?: boolean;
  /** One-request approval to bypass the direct-resume warning for T3 provenance. */
  readonly resumeT3Anyway?: boolean;
}

export interface SessionActionCoordinator {
  open(sessionId: string, options?: OpenSessionOptions): Promise<OpenSessionOutcome>;
  focusWorkspace(workspaceId: string): Promise<SessionFocusResult>;
}

/**
 * The identity/liveness authority the coordinator shares with the projection. When present it
 * answers alias resolution, live location, and resume memory, so an id the sidebar displayed is
 * always an id the actions can resolve. Absent (tests, legacy callers), the coordinator falls
 * back to its private index-only resolution.
 */
export interface SessionIdentityAuthority {
  locate(bridge: Bridge, sessionId: string): SurfaceLocation | null;
  aliasesFor(sessionId: string): readonly string[];
  canonicalFor(sessionId: string): string;
  noteResumed(sessionIds: readonly string[], target: WorkspaceFocusTarget): void;
  recentResumeTarget(sessionIds: readonly string[]): WorkspaceFocusTarget | null;
}

export interface SessionActionCoordinatorOptions {
  readonly cmuxBin: string;
  readonly now?: () => number;
  readonly recentlyResumedMs?: number;
  readonly readBridge: () => Promise<Bridge>;
  readonly lookupIndexedSession: (sessionId: string) => IndexedSessionLookup;
  readonly identity?: SessionIdentityAuthority;
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

function focusTargetFromLocation(
  location: SurfaceLocation,
  activeWindowId: string | null,
): WorkspaceFocusTarget {
  return {
    workspaceRef: location.workspaceRef,
    // select-workspace already changes the active workspace inside the focused window. Calling
    // focus-window after every same-window selection doubles cmux socket traffic without changing
    // the result. Unknown/background windows still take the explicit second command so targeting
    // remains exact rather than assuming which window the user can see.
    windowRef: location.windowId === activeWindowId ? null : location.windowRef,
  };
}

export function createSessionActionCoordinator(
  options: SessionActionCoordinatorOptions,
): SessionActionCoordinator {
  const now = options.now ?? (() => Date.now());
  const recentlyResumedMs = options.recentlyResumedMs ?? RECENTLY_RESUMED_MS;
  const defer = options.defer ?? ((task: () => void) => { setTimeout(task, 0); });
  // Claim the exact request identity before its Bridge read. HTTP requests for the same row can
  // otherwise all enter the action concurrently with the same closed liveness snapshot. The
  // canonical resume map below remains the alias backstop once index identity is known.
  const openFlights = new Map<string, Promise<OpenSessionOutcome>>();
  const resumeFlights = new Map<string, Promise<SessionResumeResult>>();
  const recentlyResumed = new Map<
    string,
    { readonly until: number; readonly target: WorkspaceFocusTarget }
  >();

  function identityIds(requestedId: string, row: IndexedSessionInput): readonly string[] {
    return [...new Set([
      ...(options.identity?.aliasesFor(requestedId) ?? [requestedId]),
      row.sessionId,
      row.resumeId,
    ])];
  }

  function recentTargetFor(sessionIds: readonly string[]): WorkspaceFocusTarget | null {
    if (options.identity) return options.identity.recentResumeTarget(sessionIds);
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
    if (options.identity) {
      options.identity.noteResumed(sessionIds, target);
      return;
    }
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
    openOptions: OpenSessionOptions,
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
      ...(openOptions.reopenCompleted ? { reopenCompleted: true } : {}),
      ...(openOptions.resumeT3Anyway ? { resumeT3Anyway: true } : {}),
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
      case "completed":
        return { status: "failed", reason: "the session is done; reopen it before resuming" };
      case "t3-confirmation-required":
        return {
          status: "failed",
          reason: "direct resume of a T3-associated session needs confirmation",
          refusal: "t3-confirmation-required",
        };
      case "reactivation-failed":
        return {
          status: "failed",
          reason: "the session resumed but could not be moved back to Active",
          refusal: "reactivation-failed",
        };
      case "liveness-unreadable":
        return { status: "liveness-unreadable" };
      // The rest are conditions a person can act on and cannot retry their way out of, so each
      // travels as a refusal code the client turns into a sentence. Their free-text detail stays
      // server-side: `route-ineligible` carries the launcher's own explanation, and
      // `cwd-unreadable` carries a filesystem error and an absolute path.
      case "route-ineligible":
      case "unknown-launcher":
      case "launcher-env-unresolvable":
      case "spawn-failed":
      case "cwd-unreadable":
        return { status: "failed", reason: result.status, refusal: result.status };
    }
  }

  async function focusWorkspace(workspaceId: string): Promise<SessionFocusResult> {
    const bridge = await options.readBridge();
    if (!bridge.readable) return { status: "liveness-unreadable" };
    const location = bridge.surfacesInWorkspace(workspaceId)[0];
    if (!location) return { status: "not-live" };
    return focusTarget(focusTargetFromLocation(location, bridge.activeWindowId));
  }

  async function openOnce(
    sessionId: string,
    openOptions: OpenSessionOptions,
  ): Promise<OpenSessionOutcome> {
    const bridge = await options.readBridge();
    if (!bridge.readable) return { status: "liveness-unreadable" };

    // The row clicked by the sidebar carries the projection's canonical id. Resolve the direct
    // path — through the shared identity authority when present, so every alias the projection
    // could have joined on is tried — before touching SQLite: the index is only needed for an
    // alias identity has not learned yet, or a closed session.
    const directLocation = options.identity
      ? options.identity.locate(bridge, sessionId)
      : bridge.locateSession(sessionId);
    if (directLocation) {
      const focused = await focusTarget(focusTargetFromLocation(directLocation, bridge.activeWindowId));
      return openOutcomeFromFocus(focused);
    }

    const lookup = options.lookupIndexedSession(sessionId);
    const row = lookup.status === "found" ? lookup.row : null;
    const aliasLocation = [row?.sessionId, row?.resumeId]
      .filter((candidate): candidate is string => candidate !== undefined && candidate !== sessionId)
      .map((candidate) => bridge.locateSession(candidate))
      .find((location): location is SurfaceLocation => location !== null);
    if (aliasLocation) {
      const focused = await focusTarget(focusTargetFromLocation(aliasLocation, bridge.activeWindowId));
      return openOutcomeFromFocus(focused);
    }

    if (lookup.status !== "found") {
      // The resume hint's whole reason to exist is the window where the index has no row yet: a
      // resume this coordinator just performed, before the indexer's next scan. Consult it before
      // declaring the session unknown, or the second click on a freshly resumed row 404s.
      const hinted = recentTargetFor(options.identity?.aliasesFor(sessionId) ?? [sessionId]);
      if (hinted) {
        const focused = await focusTarget(hinted);
        return openOutcomeFromFocus(focused);
      }
      return lookup.status === "absent"
        ? { status: "not-found" }
        : { status: "index-unreadable" };
    }
    const sessionIds = identityIds(sessionId, lookup.row);
    const recent = recentTargetFor(sessionIds);
    if (recent) {
      const focused = await focusTarget(recent);
      return openOutcomeFromFocus(focused);
    }

    // Flights key on the canonical id so two concurrent clicks arriving under two aliases of one
    // session join one resume instead of both entering it.
    const resumeKey = options.identity?.canonicalFor(lookup.row.sessionId) ?? lookup.row.sessionId;
    const existingFlight = resumeFlights.get(resumeKey);
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
        // A joined flight reports what the flight found, refusal included: two clicks on one row
        // must not be told two different stories about why it would not open.
        return outcome.status === "failed" ? outcome : {
          status: "failed",
          reason: "session is already open but its workspace was not in the action's liveness read",
        };
      }
      const focused = await focusTarget(outcome.target);
      return openOutcomeFromFocus(focused);
    }

    const flight = resume(bridge, lookup.row, sessionIds, openOptions);
    resumeFlights.set(resumeKey, flight);
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
      if (resumeFlights.get(resumeKey) === flight) {
        resumeFlights.delete(resumeKey);
      }
    }
    return { status: "failed", reason: "resume action returned no outcome" };
  }

  async function joinOpenFlight(flight: Promise<OpenSessionOutcome>): Promise<OpenSessionOutcome> {
    const outcome = await flight;
    if (outcome.status !== "resumed") return outcome;
    if (!outcome.workspaceRef) {
      return { status: "failed", reason: "cmux created no addressable workspace" };
    }
    return openOutcomeFromFocus(await focusTarget({
      workspaceRef: outcome.workspaceRef,
      windowRef: null,
    }));
  }

  async function open(
    sessionId: string,
    openOptions: OpenSessionOptions = {},
  ): Promise<OpenSessionOutcome> {
    const flightKey = options.identity?.canonicalFor(sessionId) ?? sessionId;
    const existingFlight = openFlights.get(flightKey);
    if (existingFlight) return joinOpenFlight(existingFlight);

    const flight = openOnce(sessionId, openOptions);
    openFlights.set(flightKey, flight);
    try {
      return await flight;
    } finally {
      if (openFlights.get(flightKey) === flight) openFlights.delete(flightKey);
    }
  }

  return { open, focusWorkspace };
}
