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
  SidebarScope,
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
import { Input } from "@/components/ui/input";
import { SearchIcon } from "./components/icons.tsx";
import { GroupingSelect } from "./components/grouping-select.tsx";
import { ScopeSelect } from "./components/scope-select.tsx";
import { Toasts, type Toast } from "./components/toasts.tsx";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 1_000;
const GROUPING_STORAGE_KEY = "ccs-sidebar-grouping";
const SCOPE_STORAGE_KEY = "ccs-sidebar-scope";
const CLOCK_INTERVAL_MS = 30_000;

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
  const [scope, setScope] = useState<SidebarScope>(() => {
    const stored = localStorage.getItem(SCOPE_STORAGE_KEY);
    return stored === "completed" || stored === "archived" ? stored : "active";
  });
  const [grouping, setGrouping] = useState<GroupingMode>(
    () => parseGroupingMode(localStorage.getItem(GROUPING_STORAGE_KEY)),
  );
  const [now, setNow] = useState(() => Date.now());
  /** True while Command is held. Only observable when this page holds keyboard focus. */
  const [metaHeld, setMetaHeld] = useState(false);
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
            const response = await fetch(`/api/snapshot?scope=${requestScope}`);
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
        <ScopeSelect
          onChange={(next) => {
            if (next === selectedScopeRef.current) return;
            selectedScopeRef.current = next;
            setScope(next);
            setSnapshot(null);
            setSnapshotError(null);
            localStorage.setItem(SCOPE_STORAGE_KEY, next);
            load();
          }}
          value={scope}
        />
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
                registerRef={(element) => {
                  rowRefs.current[flatRows.indexOf(row)] = element;
                }}
              />
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

      <Toasts onDismiss={() => setActionError(null)} toasts={toasts} />
    </div>
  );
}
