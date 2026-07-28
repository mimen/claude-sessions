/**
 * The productivity sidebar.
 *
 * One question, top to bottom: what deserves attention next? Rows are grouped by cmux's own
 * Claude status, then by whether the session is still live. Clicking a row focuses it when it
 * is running and resumes it through CCS when it is not; the browser never decides which.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SidebarRow,
  SidebarView,
  SidebarSection,
  SidebarSessionRow,
  SidebarSnapshot,
} from "../projection.ts";
import {
  emptyStateMessage,
  GROUPING_LABELS,
  groupSessions,
  parseGroupingMode,
  shouldApplySnapshotResponse,
  shouldReloadSnapshot,
  type GroupingMode,
} from "./format.ts";
import { SessionRow } from "./components/session-row.tsx";
import { CompactRow } from "./components/compact-row.tsx";
import { HoverSummary, type HoverTarget } from "./components/hover-summary.tsx";
import { Input } from "@/components/ui/input";
import { SearchIcon } from "./components/icons.tsx";
import { GroupingSelect } from "./components/grouping-select.tsx";
import { ScopeSelect } from "./components/scope-select.tsx";
import { LifecycleBars } from "./components/lifecycle-bars.tsx";
import { Toasts, type Toast } from "./components/toasts.tsx";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 1_000;
const GROUPING_STORAGE_KEY = "ccs-sidebar-grouping";
const SCOPE_STORAGE_KEY = "ccs-sidebar-scope";
const CLOCK_INTERVAL_MS = 30_000;
/** Long enough not to fire while scanning past rows, short enough not to feel like waiting. */
const HOVER_DELAY_MS = 220;
/** Rows requested initially, and the step added each time the list is scrolled near its end. */
const ROW_PAGE = 40;
/** How close to the bottom counts as "near the end", in px. */
const SCROLL_THRESHOLD_PX = 240;

type OpenStatus = "focused" | "resumed" | "not-found" | "liveness-unreadable" | "failed";

interface OpenResponse {
  readonly status?: OpenStatus;
  readonly reason?: string;
  readonly error?: string;
}

interface FocusResponse {
  readonly status?: "focused" | "not-live" | "liveness-unreadable" | "failed";
  readonly reason?: string;
  readonly error?: string;
}

function focusFailure(result: FocusResponse, response: Response): string | null {
  if (result.error) return result.error;
  switch (result.status) {
    case "focused":
      return null;
    case "failed":
      return result.reason ?? "could not focus that tab";
    case "not-live":
      return "that tab is no longer open";
    case "liveness-unreadable":
      return "cmux state is unreadable; nothing was focused";
    default:
      return response.ok ? "could not focus that tab" : `focus failed (${response.status})`;
  }
}

function openFailure(result: OpenResponse, response: Response): string | null {
  if (result.error) return result.error;
  switch (result.status) {
    case "focused":
    case "resumed":
      return null;
    case "failed":
      return result.reason ?? "could not open the session";
    case "not-found":
      return "that session is no longer indexed";
    case "liveness-unreadable":
      return "cmux state is unreadable; nothing was opened";
    default:
      return response.ok ? "could not open the session" : `open failed (${response.status})`;
  }
}

export function App(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<SidebarSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openingIds, setOpeningIds] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  // Selection follows the session, not its position: a poll that adds or moves a row must not
  // silently change which one Enter would open.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Lifecycle changes shown before the server confirms them; cleared once a snapshot agrees. */
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, SidebarSessionRow["lifecycle"]>>(
    () => new Map(),
  );
  /** Pin changes shown before the poll confirms them, keyed by workspace UUID. */
  const [optimisticPins, setOptimisticPins] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [scope, setScope] = useState<SidebarView>(() => {
    const stored = localStorage.getItem(SCOPE_STORAGE_KEY);
    return stored === "completed" || stored === "archived" || stored === "triage"
      ? stored
      : "active";
  });
  const [grouping, setGrouping] = useState<GroupingMode>(
    () => parseGroupingMode(localStorage.getItem(GROUPING_STORAGE_KEY)),
  );
  const [now, setNow] = useState(() => Date.now());
  /** True while Command is held. Only observable when this page holds keyboard focus. */
  const [metaHeld, setMetaHeld] = useState(false);
  /**
   * Whether the pointer is inside the sidebar right now.
   *
   * A hover card asserts where the mouse is, so it has to be retractable by the same fact. Row-level
   * `mouseleave` is not enough on its own: moving the pointer out of the window in one motion, or
   * another app taking focus, can leave a row believing it is still hovered and strand a card on
   * screen with the mouse nowhere near it.
   */
  const [pointerInside, setPointerInside] = useState(false);
  /**
   * The one row whose summary is showing. Single-valued on purpose: two cards at once was the
   * previous design's routine failure, and it was possible only because each row owned its own.
   */
  const [hoverTarget, setHoverTarget] = useState<HoverTarget | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * How many rows the server is currently asked for.
   *
   * The list used to stop at eight closed sessions with nothing to say it had, while thousands
   * existed -- a silent truncation is worse than a visible one, because a session you cannot find
   * looks like a session that is gone. This grows as you reach the end, so the list simply
   * continues.
   */
  const [rowLimit, setRowLimit] = useState(ROW_PAGE);
  const rowLimitRef = useRef(ROW_PAGE);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openingIdsRef = useRef(new Set<string>());
  const selectedScopeRef = useRef(scope);
  const snapshotLoadInFlightRef = useRef(false);
  const snapshotReloadQueuedRef = useRef(false);
  const nextSnapshotRequestIdRef = useRef(0);
  const latestAppliedSnapshotRequestIdRef = useRef(0);

  // Polls share one flight. The selected scope lives in a ref so the stable poll callback always
  // reads the current value. Scope changes trigger one trailing read only when the active request
  // is for a different scope; user actions can still require one same-scope freshness read.
  const load = useCallback((ensureFresh = false): void => {
    if (snapshotLoadInFlightRef.current) {
      if (ensureFresh) snapshotReloadQueuedRef.current = true;
      return;
    }

    const run = async (): Promise<void> => {
      snapshotLoadInFlightRef.current = true;
      let requestScope = selectedScopeRef.current;
      try {
        do {
          snapshotReloadQueuedRef.current = false;
          requestScope = selectedScopeRef.current;
          const requestId = ++nextSnapshotRequestIdRef.current;
          try {
            const response = await fetch(
              `/api/snapshot?scope=${requestScope}&limit=${rowLimitRef.current}`,
            );
            if (!response.ok) throw new Error(`snapshot failed (${response.status})`);
            const nextSnapshot = (await response.json()) as SidebarSnapshot;
            // The server has spoken; stop overriding any row it now agrees about.
            setOptimistic((current) => {
              if (current.size === 0) return current;
              const next = new Map(current);
              for (const row of nextSnapshot.rows) {
                if (row.kind !== "session") continue;
                if (next.get(row.sessionId) === row.lifecycle) next.delete(row.sessionId);
              }
              return next.size === current.size ? current : next;
            });
            setOptimisticPins((current) => {
              if (current.size === 0) return current;
              const next = new Map(current);
              for (const row of nextSnapshot.rows) {
                if (row.workspaceId !== null && next.get(row.workspaceId) === row.pinned) {
                  next.delete(row.workspaceId);
                }
              }
              return next.size === current.size ? current : next;
            });
            if (shouldApplySnapshotResponse(
              requestScope,
              selectedScopeRef.current,
              requestId,
              latestAppliedSnapshotRequestIdRef.current,
            )) {
              latestAppliedSnapshotRequestIdRef.current = requestId;
              setSnapshot(nextSnapshot);
              setSnapshotError(null);
            }
          } catch (cause) {
            if (requestScope === selectedScopeRef.current) {
              setSnapshotError(cause instanceof Error ? cause.message : "snapshot failed");
            }
          }
        } while (shouldReloadSnapshot(
          requestScope,
          selectedScopeRef.current,
          snapshotReloadQueuedRef.current,
        ));
      } finally {
        snapshotLoadInFlightRef.current = false;
      }
    };

    void run();
  }, []);

  useEffect(() => {
    const sync = (event: KeyboardEvent): void => setMetaHeld(event.metaKey);
    // Holding Command and switching away never delivers the keyup, so blur has to clear it or
    // the badges stay up until the next keystroke.
    const clear = (): void => setMetaHeld(false);
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);

  // The same failure the Command badges have, for the same reason: an exit the container never
  // sees. `mouseout` to a null relatedTarget is the pointer leaving the document entirely, and
  // blur/visibilitychange cover another window or app taking over. Any of them means the mouse is
  // no longer here, so no hover card may claim otherwise.
  useEffect(() => {
    const leave = (): void => {
      setPointerInside(false);
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
      setHoverTarget(null);
    };
    const onMouseOut = (event: MouseEvent): void => {
      if (event.relatedTarget === null) leave();
    };
    document.addEventListener("mouseout", onMouseOut);
    document.addEventListener("visibilitychange", leave);
    window.addEventListener("blur", leave);
    return () => {
      document.removeEventListener("mouseout", onMouseOut);
      document.removeEventListener("visibilitychange", leave);
      window.removeEventListener("blur", leave);
    };
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(() => load(), POLL_INTERVAL_MS);
    const clock = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const groups = useMemo(() => {
    const all = (snapshot?.rows ?? []).map((row) => {
      const pendingPin = row.workspaceId === null ? undefined : optimisticPins.get(row.workspaceId);
      if (pendingPin !== undefined && pendingPin !== row.pinned) row = { ...row, pinned: pendingPin };
      if (row.kind !== "session") return row;
      const pending = optimistic.get(row.sessionId);
      return pending && pending !== row.lifecycle ? { ...row, lifecycle: pending } : row;
      // A sessionless workspace has no lifecycle to browse by, so it belongs to the live view
      // only — it would be dishonest to list a running browser pane under Completed.
    }).filter((row) => (row.kind === "session" ? row.lifecycle === scope : scope === "active"));
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? all.filter((row) =>
          `${row.name} ${row.directory ?? ""} ${row.worktree ?? ""}`.toLowerCase().includes(needle))
      : all;
    return groupSessions(matched, grouping, now);
  }, [snapshot, query, grouping, now, optimistic, optimisticPins, scope]);

  // One flat order underlies the groups so arrow keys cross headings without special cases.
  const flatRows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);

  const selected = useMemo(() => {
    if (selectedId === null) {
      const focused = flatRows.findIndex((row) => row.focused);
      if (focused >= 0) return focused;
    }
    const index = flatRows.findIndex((row) => row.id === selectedId);
    // A selection whose row disappeared falls back to the top of the queue rather than to
    // whatever row happens to now occupy its old position.
    return index >= 0 ? index : 0;
  }, [flatRows, selectedId]);

  // Ongoing degradations stay up while they last; a failed action fades on its own.
  const toasts = useMemo((): Toast[] => {
    const items: Toast[] = [];
    if (snapshotError) {
      items.push({ id: "snapshot", message: snapshotError, persistent: true });
    }
    if (snapshot && !snapshot.livenessReadable) {
      items.push({
        id: "liveness",
        message: "cmux state is unreadable, so live sessions cannot be confirmed. Resuming is disabled.",
        persistent: true,
      });
    }
    if (snapshot && !snapshot.indexReadable) {
      items.push({
        id: "index",
        message: "The session index is unreadable, so models and recent sessions are missing.",
        persistent: true,
      });
    }
    if (actionError) items.push({ id: "action", message: actionError, persistent: false });
    return items;
  }, [actionError, snapshot, snapshotError]);

  const emptyMessage = snapshot && flatRows.length === 0
    ? emptyStateMessage(query, snapshot.livenessReadable)
    : null;

  const moveSelection = useCallback((delta: number) => {
    const next = Math.min(flatRows.length - 1, Math.max(0, selected + delta));
    const row = flatRows[next];
    if (!row) return;
    setSelectedId(row.id);
    rowRefs.current[next]?.scrollIntoView({ block: "nearest" });
  }, [flatRows, selected]);

  const open = useCallback(async (row: SidebarRow): Promise<void> => {
    // The ref closes the same-tick gap before disabled state reaches the button.
    if (openingIdsRef.current.has(row.id)) return;
    openingIdsRef.current.add(row.id);
    setOpeningIds(new Set(openingIdsRef.current));
    setActionError(null);

    try {
      // A workspace row has no session to resume — clicking it is purely "show me that tab".
      if (row.kind === "workspace") {
        const response = await fetch("/api/workspace/focus", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId: row.workspaceId }),
        });
        setActionError(focusFailure((await response.json()) as FocusResponse, response));
        load(true);
        return;
      }
      const response = await fetch("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: row.sessionId }),
      });
      const result = (await response.json()) as OpenResponse;
      setActionError(openFailure(result, response));
      load(true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "could not open the session");
    } finally {
      openingIdsRef.current.delete(row.id);
      setOpeningIds(new Set(openingIdsRef.current));
    }
  }, [load]);

  /**
   * Open the card after a short rest on a row, and close it the instant the pointer leaves.
   *
   * Asymmetric by design: the delay exists so scanning down the list does not fire a paragraph
   * under the cursor on every row, but once you have left there is nothing to debounce -- a card
   * that lingers is the bug, not a feature.
   */
  const onHover = useCallback((row: SidebarRow, element: HTMLElement | null): void => {
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    if (element === null || row.kind !== "session") {
      setHoverTarget(null);
      return;
    }
    const rect = element.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => setHoverTarget({ row, rect }), HOVER_DELAY_MS);
  }, []);

  /**
   * Switch which lifecycle the list shows.
   *
   * Shared by the scope dropdown and the bottom bars so the two can never disagree about what is on
   * screen; the bars are simply a more reachable affordance for the same state.
   */
  const selectScope = useCallback((next: SidebarView): void => {
    if (next === selectedScopeRef.current) return;
    selectedScopeRef.current = next;
    setScope(next);
    // The rows on screen belong to the old scope, so keeping them while the new ones load would
    // show completed sessions under an "Archived" heading for one poll.
    setSnapshot(null);
    setSnapshotError(null);
    rowLimitRef.current = ROW_PAGE;
    setRowLimit(ROW_PAGE);
    localStorage.setItem(SCOPE_STORAGE_KEY, next);
    load();
  }, [load]);

  const setLifecycle = useCallback((
    row: SidebarSessionRow,
    action: "complete" | "archive" | "uncomplete" | "unarchive",
  ): void => {
    const optimisticLifecycle: SidebarSessionRow["lifecycle"] = action === "complete"
      ? "completed"
      : action === "archive"
        ? "archived"
        : "active";
    setOptimistic((current) => new Map(current).set(row.sessionId, optimisticLifecycle));

    const revert = (): void => {
      setOptimistic((current) => {
        const next = new Map(current);
        next.delete(row.sessionId);
        return next;
      });
    };

    void (async (): Promise<void> => {
      try {
        const response = await fetch("/api/session/lifecycle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: row.sessionId, action }),
        });
        const result = (await response.json()) as { status?: string; reason?: string; error?: string; closeFailed?: string };
        // Only a failure is worth saying; the row leaving the list is its own confirmation.
        if (result.error) { setActionError(result.error); revert(); }
        else if (result.status === "failed") { setActionError(result.reason ?? `could not ${action} the session`); revert(); }
        else if (result.status === "not-found") { setActionError("that session is not in the catalogue"); revert(); }
        else if (result.closeFailed) setActionError(`marked, but the workspace stayed open: ${result.closeFailed}`);
        else setActionError(null);
        load(true);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : `could not ${action} the session`);
        revert();
      }
    })();
  }, [load]);

  /**
   * Pins are cmux's, so the poll will confirm this a beat later. The optimistic entry keeps the
   * row from snapping back to its old group in the meantime, which is the whole point of a pin.
   */
  const setPinned = useCallback((row: SidebarRow, pinned: boolean): void => {
    if (row.workspaceId === null) return;
    const workspaceId = row.workspaceId;
    setOptimisticPins((current) => new Map(current).set(workspaceId, pinned));
    void (async (): Promise<void> => {
      try {
        const response = await fetch("/api/workspace/pin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspaceId, pinned }),
        });
        const result = (await response.json()) as { status?: string; reason?: string; error?: string };
        if (result.status !== "pinned") {
          setActionError(result.error ?? result.reason ?? "could not change the pin");
          setOptimisticPins((current) => {
            const next = new Map(current);
            next.delete(workspaceId);
            return next;
          });
        } else setActionError(null);
        load(true);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "could not change the pin");
        setOptimisticPins((current) => {
          const next = new Map(current);
          next.delete(workspaceId);
          return next;
        });
      }
    })();
  }, [load]);

  const closeWorkspace = useCallback((row: SidebarRow): void => {
    void (async (): Promise<void> => {
      try {
        // A sessionless tab has no session to close through; the server refuses this route for
        // any workspace that does hold one, so the session proofs cannot be sidestepped here.
        const response = row.kind === "workspace"
          ? await fetch("/api/workspace/close", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspaceId: row.workspaceId }),
          })
          : await fetch("/api/session/close", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: row.sessionId }),
          });
        const result = (await response.json()) as { status?: string; reason?: string; error?: string };
        if (result.error) setActionError(result.error);
        else if (result.status === "failed") setActionError(result.reason ?? "could not close the workspace");
        else if (result.status === "liveness-unreadable") setActionError("cmux state is unreadable; nothing was closed");
        else setActionError(null);
        load(true);
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "could not close the workspace");
      }
    })();
  }, [load]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      const row = flatRows[selected];
      if (!row) return;
      event.preventDefault();
      void open(row);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
  }, [flatRows, moveSelection, open, selected]);

  return (
    <div
      className="relative flex h-full flex-col bg-background text-foreground"
      // `mouseleave` on the container catches the ordinary exit; the window listeners below catch
      // the ones it misses, which are the cases that actually strand a card.
      onMouseEnter={() => setPointerInside(true)}
      onMouseLeave={() => { setPointerInside(false); onHover({ kind: 'session' } as SidebarRow, null); }}
      onKeyDown={onKeyDown}
    >
      {/*
        * The filter is the resting state of this bar, so it reads as a field; the arrangement
        * control sits beside it with a border, an icon and a chevron so it is obviously a button
        * and obviously cycles. Both share one height so the bar has a single baseline.
        */}
      {/*
        * The top inset clears the host's floating window controls. cmux publishes it only to a page
        * that asked for the full sidebar rect; anywhere else the property is unset and the fallback
        * collapses it to the plain `py-2` bar, so this renders identically in a browser tab.
        */}
      <div className="flex items-center gap-1.5 border-b border-border px-2 pt-[calc(0.5rem+var(--cmux-sidebar-inset-top,0px))] pb-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-7 border-transparent bg-muted/50 pl-7 text-xs shadow-none focus-visible:border-ring dark:bg-muted/50"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter"
            type="search"
            value={query}
          />
        </div>
        <ScopeSelect onChange={selectScope} value={scope} />
        <GroupingSelect
          onChange={(next) => {
            setGrouping(next);
            localStorage.setItem(GROUPING_STORAGE_KEY, next);
          }}
          value={grouping}
        />
      </div>

      {/* Bottom padding rather than a shorter list, so rows scroll *under* the host's footer
        * instead of stopping short of it — the last row stays reachable either way. */}
      <div
        className="session-list flex-1 overflow-y-auto px-1.5 pt-1.5 pb-[var(--cmux-sidebar-inset-bottom,0px)]"
        // Asking for more before the end is reached, so the next rows are already there by the
        // time you get to them. Only ever grows: shrinking the window mid-scroll would pull rows
        // out from under the pointer.
        onScroll={(event) => {
          const el = event.currentTarget;
          const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
          if (remaining > SCROLL_THRESHOLD_PX) return;
          if (rowLimitRef.current > flatRows.length + ROW_PAGE) return;
          rowLimitRef.current += ROW_PAGE;
          setRowLimit(rowLimitRef.current);
          load(true);
        }}
        ref={listRef}
      >
        {groups.map((group) => (
          <div key={group.key}>
            {group.label ? (
              <div className="flex items-center gap-1.5 px-0.5 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                <span className="truncate">{group.label}</span>
                <span className="font-semibold opacity-70">{group.rows.length}</span>
              </div>
            ) : null}
            {group.rows.map((row) => (
              // Density is decided in the projection, so the view only has to honour it. A closed
              // or settled session collapses to a line; anything live keeps the full card.
              row.kind === "session" && row.density !== "full" ? (
                <CompactRow
                  key={row.id}
                  now={now}
                  onAccept={setLifecycle}
                  onOpen={(clicked) => { setSelectedId(clicked.id); void open(clicked); }}
                  opening={openingIds.has(row.id)}
                  registerRef={(_id, element) => {
                    rowRefs.current[flatRows.indexOf(row)] = element as HTMLButtonElement | null;
                  }}
                  onHover={onHover}
                  row={row}
                  selected={flatRows[selected]?.id === row.id}
                />
              ) : (
                <SessionRow
                  key={row.id}
                  row={row}
                  now={now}
                  selected={flatRows[selected]?.id === row.id}
                  showShortcut={metaHeld}
                  opening={openingIds.has(row.id)}
                  onClose={closeWorkspace}
                  onLifecycle={setLifecycle}
                  onPin={setPinned}
                  onOpen={(clicked) => { setSelectedId(clicked.id); void open(clicked); }}
                  onHover={onHover}
                  registerRef={(element) => {
                    rowRefs.current[flatRows.indexOf(row)] = element;
                  }}
                />
              )
            ))}
          </div>
        ))}

        {emptyMessage ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyMessage}</div>
        ) : null}
        {!snapshot && !snapshotError ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : null}
      </div>

      <LifecycleBars
        counts={snapshot?.lifecycleCounts ?? { active: 0, completed: 0, archived: 0 }}
        onSelect={selectScope}
        scope={scope === "triage" ? "active" : scope}
      />

      {/* One card for the whole list, rendered outside it so scrolling the list cannot clip it. */}
      <HoverSummary target={hoverTarget} />

      <Toasts onDismiss={() => setActionError(null)} toasts={toasts} />
    </div>
  );
}
