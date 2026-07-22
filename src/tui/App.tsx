import React, { useState, useMemo, useEffect, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useTerminalSize } from "./useTerminalSize.ts";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { Titler } from "../titler/codex.ts";
import type { EngineName, InferenceEngine } from "../inference/engine.ts";
import {
  listByRecency,
  ftsMatchIds,
  getSkeleton,
  subagentCounts,
  childrenOf,
  saveCodexTitle,
  type SessionRow,
} from "../index/index.ts";
import { backfillTitles } from "../titler/queue.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "../resume/command.ts";
import { resumeSessionEntry } from "../resume/resume-session.ts";
import {
  DEFAULT_LAUNCHERS,
  defaultRoute,
  launchersFrom,
  resolveRoutes,
  type Launcher,
  type Route,
} from "../resume/launchers.ts";
import { RoutePicker } from "./RoutePicker.tsx";
import { resolveTarget, cmuxReachableAsync } from "../resume/target.ts";
import { openInCmux } from "../resume/cmux.ts";
import { focusSession, openSessionTitlesAsync } from "../cmux/liveness.ts";
import { searchRows } from "./search.ts";
import { buildDisplayItems, type SortMode } from "./groupByProject.ts";
import { SessionList } from "./SessionList.tsx";
import { Preview } from "./Preview.tsx";
import { Help, KeyBar } from "./Help.tsx";
import { Header, type DashStats } from "./Header.tsx";
import { ListHeader } from "./ListHeader.tsx";
import { SectionCard } from "./SectionCard.tsx";
import { Transcript } from "./Transcript.tsx";
import { readTranscript, type TranscriptLine } from "../transcript.ts";
import { theme } from "./theme.ts";
import { getAll, lifecycleOf, parentEdges, setCompleted, setArchived, setCustomTitle, identityKeyOf, type CatalogueRow } from "../catalogue/db.ts";
import { buildCostRollup, type CostRollup } from "../index/cost-rollup.ts";
import { boardIndex } from "../board/indexer.ts";
import { allGroupingsAcrossClusters } from "../state/groupings.ts";
import { describe as describeDisposition } from "../catalogue/disposition.ts";
import { loadPrefs, savePrefs } from "./prefs.ts";
import { runMetadataCommand, applyMutations, type SessionMeta } from "../catalogue/command.ts";
import { buildStateItems, DEFAULT_COLLAPSED } from "./stateGroups.ts";
import { buildTreeItems } from "./treeGroups.ts";
import { buildGroupsView } from "./groupsView.ts";
import { buildClusterView } from "./clusterView.ts";
import { buildEpicView } from "./epicView.ts";
import { getCrashReporter } from "../crashlog.ts";
import { tasksFor, sessionsWithTasks } from "../tasks/reader.ts";
import { SESSION_CLASS_ROLLOUT_MS } from "../session-class.ts";

/**
 * State label + hex color for the TUI stage column (ADR-0077). Reads the first pill from the
 * cluster's board.json via the mtime-cached indexer. Cluster vocabulary; the tool doesn't
 * interpret. Missing cluster / missing board / no pill → null (column stays blank).
 */
function stagePillFor(cat: CatalogueRow | null, sessionId: string): { label: string; color?: string } | null {
  if (!cat || !cat.cluster) return null;
  try {
    const hit = boardIndex(cat.cluster).bySession(sessionId);
    const pill = hit?.row.pills[0];
    if (!pill) return null;
    return { label: pill.label, color: pill.color };
  } catch {
    return null;
  }
}

const SORT_CYCLE: SortMode[] = ["recent", "cost", "msgs"];
type View = "groups" | "state" | "flat" | "tree" | "cluster" | "epic";
const VIEW_CYCLE: View[] = ["groups", "state", "flat", "tree", "cluster", "epic"];

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Union recursive physical closures for a visible group. This keeps hidden auxiliary/native work
 * in its owner's section total while counting a visible descendant only once.
 */
export function aggregateSectionCost(rows: readonly SessionRow[], rollup: CostRollup): number {
  const physicalIds = new Set<string>();
  const fallbackCosts = new Map(rows.map((row) => [row.sessionId, row.costUSD]));
  for (const row of rows) {
    const closure = rollup.bySessionId.get(row.sessionId)?.physicalSessionIds;
    if (closure) for (const id of closure) physicalIds.add(id);
    else physicalIds.add(row.sessionId);
  }
  let total = 0;
  for (const id of physicalIds) total += rollup.bySessionId.get(id)?.selfCost ?? fallbackCosts.get(id) ?? 0;
  return total;
}

/** The inference engine state shared by Root and the sessions panel. */
export interface EngineState {
  titler: Titler;
  engine: InferenceEngine | null;
  active: EngineName | null;
  available: EngineName[];
  cycle: () => void;
}

/** Per-row visual style derived from catalogue lifecycle × live open-state. */
export interface SessionBadge {
  glyph: string;
  color: string;
  nudge: boolean;
  /** Event slug this session is assigned to (catalogue.event), if any. */
  event?: string | null;
  /** PR number + state (catalogue pr_number/pr_state), shown as a #-badge. */
  pr?: number | null;
  prState?: string | null;
  /** Role (catalogue.skill), shown in the role column. */
  role?: string | null;
  /** Status label (lifecycle × live open-state), shown in the status column. */
  status?: string | null;
  /** Composed state pill label from the cluster's board.json (ADR-0077). */
  phase?: string | null;
  /** Optional hex color matching the cmux tab pill — the TUI renders the label in this color. */
  phaseColor?: string | null;
  /** Claude Code task list (~/.claude/tasks/<id>/): completed/total counts for the ▣ column. */
  taskDone?: number | null;
  taskTotal?: number | null;
  /** An in_progress task in a session that isn't open — abandoned mid-task. */
  taskInterrupted?: boolean;
  /** Explicit execution classification warning shown beside the title. */
  classification?: "AUX" | "UNCLASSIFIED" | null;
}

/** Narrow cmux seam for the mount-time TUI probes. */
export interface TuiCmuxProbes {
  reachable(): Promise<boolean>;
  openSessionTitles(): Promise<Map<string, string>>;
}

const productionCmuxProbes: TuiCmuxProbes = {
  reachable: () => cmuxReachableAsync(),
  openSessionTitles: () => openSessionTitlesAsync(),
};

/** Cycle for the `u` key: everything → sessions with unfinished tasks → interrupted only. */
type TaskFilter = "all" | "open" | "interrupted";
const TASK_FILTER_CYCLE: TaskFilter[] = ["all", "open", "interrupted"];

interface AppProps {
  db: Database;
  config: Config;
  engineState: EngineState;
  /** Durable user metadata. Optional so tests can mount without a catalogue (no cmux probe). */
  catalogue?: Database;
  /** Inline resume is handed back to the launcher here, after the app exits. */
  resumeRequest: { current: ResumeCommand | null };
  /** Tab-toggle to the skills panel (provided by Root; absent in tests). */
  onSwitchMode?: () => void;
  /** Cross-jump pin from skills mode: only sessions whose transcript path is in the set. */
  pinned?: { paths: ReadonlySet<string>; label: string } | null;
  onClearPinned?: () => void;
  /** Optional test seam; production defaults to non-blocking cmux probes. */
  cmuxProbes?: TuiCmuxProbes;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function App({ db, catalogue, config, engineState, resumeRequest, onSwitchMode, pinned, onClearPinned, cmuxProbes = productionCmuxProbes }: AppProps): React.ReactElement {
  const { titler, engine, active: activeEngine, available: availableEngines, cycle: cycleEngine } = engineState;
  const { exit } = useApp();
  const { columns: cols, rows: termRows } = useTerminalSize();

  // Cross-backend launcher fleet from config `[[launcher]]`. A duplicate-name config error
  // falls back to plain `claude` here (the CLI stays loud; the TUI must still render).
  const launchers = useMemo<readonly Launcher[]>(() => {
    const l = launchersFrom(config.launcher);
    return "error" in l ? DEFAULT_LAUNCHERS : l;
  }, [config]);
  // The `r` overlay: route picker over the selected session (owns input while open).
  const [routePicker, setRoutePicker] = useState<{
    row: SessionRow;
    routes: Route[];
    selected: number;
    live: boolean;
  } | null>(null);

  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [showAuxiliary, setShowAuxiliary] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [refreshTick, setRefreshTick] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Natural-language metadata command (Codex-backed). scope "all" = whole catalogue; "session" =
  // the selected row. busy = a Codex call is in flight.
  const [command, setCommand] = useState<{ scope: "all" | "session"; buffer: string; busy: boolean } | null>(null);
  // Remembered view: reopen on the last view used (default "cluster"). Persisted on change.
  const [view, setView] = useState<View>(() => {
    const saved = loadPrefs().view;
    return saved && (VIEW_CYCLE as string[]).includes(saved) ? (saved as View) : "cluster";
  });
  useEffect(() => {
    savePrefs({ view });
  }, [view]);
  const [sort, setSort] = useState<SortMode>("recent");
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(DEFAULT_COLLAPSED);
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [titling, setTitling] = useState<{ done: number; total: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<
    { title: string; lines: TranscriptLine[]; truncated: boolean; scroll: number } | null
  >(null);
  // Preview pane: `d` swaps the compact peek view for the full metadata dossier; J/K scroll the
  // peek over the real transcript (lazily loaded, cached per session so revisits are instant).
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [peekScroll, setPeekScroll] = useState(0);
  const [peekLines, setPeekLines] = useState<TranscriptLine[] | null>(null);
  const peekCache = useRef<Map<string, TranscriptLine[]>>(new Map());

  const reload = () => setRefreshTick((t) => t + 1);
  // cmux probes must be ASYNC in the TUI. In render they block React mid-frame; even in an
  // effect a sync spawn blocks the event loop and re-enters the work loop ("Should not
  // already be working." — the Tab-between-modes crash, since every toggle remounts App).
  const [reachable, setReachable] = useState(false);
  useEffect(() => {
    getCrashReporter()?.breadcrumb("tui.app.mount");
    return () => getCrashReporter()?.breadcrumb("tui.app.unmount");
  }, []);
  useEffect(() => {
    let alive = true;
    getCrashReporter()?.breadcrumb("tui.cmux.reachable.start");
    void cmuxProbes.reachable().then(
      (value) => {
        if (!alive) {
          getCrashReporter()?.breadcrumb("tui.cmux.reachable.cancelled");
          return;
        }
        setReachable(value);
        getCrashReporter()?.breadcrumb("tui.cmux.reachable.success", { reachable: value });
      },
      () => {
        if (!alive) {
          getCrashReporter()?.breadcrumb("tui.cmux.reachable.cancelled");
          return;
        }
        setReachable(false);
        getCrashReporter()?.breadcrumb("tui.cmux.reachable.failure");
      },
    );
    return () => { alive = false; };
  }, [cmuxProbes]);

  // Catalogue join: custom-title override + lifecycle; live open-state from cmux. Only when a
  // catalogue is present (tests mount without one, so no cmux probe runs there).
  const catMap = useMemo(
    () => (catalogue ? getAll(catalogue) : new Map()),
    [catalogue, refreshTick],
  );
  // Grouping (epic) display metadata is CLUSTER RUNTIME state now (ADR-0051), not a platform
  // epics table. Read it across all clusters and adapt to the {name,shortName,url} shape the
  // TUI's epic views expect — the clickable-epic experience is unchanged, just re-sourced.
  const epicMap = useMemo(() => {
    const out = new Map<string, { name: string | null; shortName: string | null; url: string | null }>();
    for (const [id, g] of allGroupingsAcrossClusters()) {
      out.set(id, { name: g.label, shortName: g.shortName, url: g.url });
    }
    return out;
  }, [refreshTick]);
  // ADR-0089: per-identity attrs (per-role table row). Keyed by identity_key so a row that
  // shows up on multiple sessions doesn't re-query. Fail-open: empty map if the identity
  // module isn't loadable (fresh install, tests).
  const identityAttrsMap = useMemo(() => {
    const out = new Map<string, Record<string, unknown>>();
    if (!catalogue) return out;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
      const seen = new Set<string>();
      for (const row of catMap.values() as IterableIterator<CatalogueRow>) {
        const key = row.identityKey;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const id = getIdentity(catalogue, key);
        if (id) out.set(key, id.attrs);
      }
    } catch {
      /* identity table not present or unreadable → empty; TUI degrades gracefully */
    }
    return out;
  }, [catalogue, catMap, refreshTick]);
  // Live cmux workspace titles (source of truth for open sessions) — override the ccs Title while
  // open. Also gives us the open-set (its keys) so we probe cmux once, not twice.
  const [openTitles, setOpenTitles] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!catalogue) return;
    let alive = true;
    getCrashReporter()?.breadcrumb("tui.cmux.titles.start");
    void cmuxProbes.openSessionTitles().then(
      (titles) => {
        if (!alive) {
          getCrashReporter()?.breadcrumb("tui.cmux.titles.cancelled");
          return;
        }
        setOpenTitles(titles);
        getCrashReporter()?.breadcrumb("tui.cmux.titles.success", { count: titles.size });
      },
      () => {
        if (!alive) {
          getCrashReporter()?.breadcrumb("tui.cmux.titles.cancelled");
          return;
        }
        setOpenTitles(new Map());
        getCrashReporter()?.breadcrumb("tui.cmux.titles.failure");
      },
    );
    return () => { alive = false; };
  }, [catalogue, refreshTick, cmuxProbes]);
  const openSet = useMemo(() => new Set(openTitles.keys()), [openTitles]);
  // Which sessions have a Claude Code task dir at all — one readdir, so the per-row
  // tasksFor() probe only ever runs for sessions that can have tasks (103/166 here).
  const taskIds = useMemo(() => sessionsWithTasks(), [refreshTick]);
  const allIndexedRows = useMemo(() => listByRecency(db, true), [db, refreshTick]);
  const costRollup = useMemo(
    () => buildCostRollup(allIndexedRows, catalogue ? parentEdges(catalogue) : []),
    [allIndexedRows, catalogue, refreshTick],
  );
  const baseRows = useMemo(() => {
    return allIndexedRows
      .filter((r) => includeSubagents || !r.isSubagent)
      .filter((r) => !pinned || pinned.paths.has(r.path))
      .filter((r) => showAuxiliary || catMap.get(r.sessionId)?.sessionClass !== "auxiliary")
      .filter((r) => showArchived || lifecycleOf(catMap.get(r.sessionId) ?? null) !== "archived")
      .filter((r) => {
        if (taskFilter === "all") return true;
        if (!taskIds.has(r.sessionId)) return false;
        const t = tasksFor(r.sessionId);
        if (!t || t.completed === t.total) return false;
        return taskFilter === "open" || (t.inProgress > 0 && !openSet.has(r.sessionId));
      })
      .map((r) => {
        // Precedence: live cmux title (open) → user's custom title → ROLE (a role-tagged
        // session reads as its role, e.g. "designer", not the auto-generated skeleton title)
        // → resolved Title. Mirrors render-tab so the TUI + cmux tab agree.
        const cat = catMap.get(r.sessionId);
        const title =
          openTitles.get(r.sessionId) ?? cat?.customTitle ?? cat?.role ?? r.title;
        return title === r.title ? r : { ...r, title };
      });
  }, [allIndexedRows, includeSubagents, pinned, catMap, showAuxiliary, showArchived, openTitles, taskFilter, taskIds, openSet]);

  // Write-through: persist an open session's cmux title into the catalogue so the name stays put
  // after the tab closes (cmux is the source of truth, tightly linked). Only writes on a change.
  useEffect(() => {
    if (!catalogue) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const [sid, title] of openTitles) {
      // Never persist a slug-shaped title (the session-id or its 8-char prefix): a tab that
      // briefly showed the raw id before getting a real name would otherwise poison the
      // customTitle, hiding the role/real name forever (hit the designer row).
      if (!title || sid.startsWith(title) || title === sid.slice(0, 8)) continue;
      if ((catMap.get(sid)?.customTitle ?? null) !== title) {
        setCustomTitle(catalogue, sid, title, now);
        changed = true;
      }
    }
    if (changed) reload();
  }, [catalogue, openTitles, catMap]);
  const deco = useMemo(() => {
    const m = new Map<string, SessionBadge>();
    const nowMs = Date.now();
    for (const r of baseRows) {
      const c = catMap.get(r.sessionId) ?? null;
      const open = openSet.has(r.sessionId);
      const lc = lifecycleOf(c);
      const nudge = open && (lc === "parked" || lc === "completed");
      let glyph = " ";
      let color: string = theme.title;
      if (c?.kind === "loop") {
        glyph = "◆";
        color = theme.accent;
      } else if (lc === "archived") {
        glyph = "·";
        color = theme.faint;
      } else if (lc === "completed") {
        glyph = "✓";
        color = theme.muted;
      } else if (lc === "parked") {
        glyph = "⏸";
        color = "yellow";
      } else if (open) {
        glyph = "●";
        color = theme.title;
      } else {
        const ts = r.lastTs ? Date.parse(r.lastTs) : NaN;
        color = Number.isNaN(ts) || nowMs - ts > STALE_MS ? theme.faint : theme.muted;
      }
      if (nudge) color = "yellowBright";
      const pill = stagePillFor(c, r.sessionId);
      const tasks = taskIds.has(r.sessionId) ? tasksFor(r.sessionId) : null;
      m.set(r.sessionId, {
        glyph, color, nudge,
        event: identityKeyOf(c),
        pr: c?.prNumber ?? null,
        prState: c?.prState ?? null,
        role: c?.role ?? null,
        status: describeDisposition(lc, open).label,
        phase: pill?.label ?? null,
        phaseColor: pill?.color ?? null,
        taskDone: tasks?.completed ?? null,
        taskTotal: tasks?.total ?? null,
        taskInterrupted: !!tasks && tasks.inProgress > 0 && !open,
        classification: c?.sessionClass === "auxiliary"
          ? "AUX"
          : c?.sessionClass == null && r.firstTs && Date.parse(r.firstTs) >= SESSION_CLASS_ROLLOUT_MS
            ? "UNCLASSIFIED"
            : null,
      });
    }
    return m;
  }, [baseRows, catMap, openSet, taskIds]);
  const subCounts = useMemo(() => subagentCounts(db), [db, refreshTick]);
  const totalCostFor = React.useCallback(
    (r: SessionRow): number => costRollup.bySessionId.get(r.sessionId)?.totalCost ?? r.costUSD,
    [costRollup],
  );
  const totalCostById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of baseRows) m.set(r.sessionId, totalCostFor(r));
    return m;
  }, [baseRows, totalCostFor]);
  const sectionCostFor = React.useCallback(
    (sectionRows: readonly SessionRow[]): number => aggregateSectionCost(sectionRows, costRollup),
    [costRollup],
  );
  const stats = useMemo<DashStats>(() => {
    const spend = costRollup.physicalStoreCost;
    let active = 0,
      parked = 0,
      loops = 0,
      loopSpend = 0;
    let topTitle: string | null = null;
    let topCost = 0;
    for (const r of baseRows) {
      const c = catMap.get(r.sessionId) ?? null;
      const total = totalCostFor(r);
      const lc = lifecycleOf(c);
      // Mirror stateGroups.classify precedence: loop → archived/done → parked → open.
      if (c?.kind === "loop") {
        loops++;
        loopSpend += total;
      } else if (lc === "parked") {
        parked++;
      } else if (lc !== "completed" && lc !== "archived" && openSet.has(r.sessionId)) {
        active++;
      }
      if (total > topCost) {
        topCost = total;
        topTitle = r.title;
      }
    }
    let agentSpend = 0;
    for (const row of allIndexedRows) {
      if (row.isSubagent || catMap.get(row.sessionId)?.sessionClass === "auxiliary") agentSpend += row.costUSD;
    }
    return {
      host: config.host.label,
      sessions: baseRows.length,
      spend,
      active,
      parked,
      loops,
      loopSpend,
      agentSpend,
      topTitle,
      topCost,
    };
  }, [baseRows, allIndexedRows, catMap, openSet, costRollup, totalCostFor, config.host.label]);
  const titleById = useMemo(() => new Map(baseRows.map((r) => [r.sessionId, r.title])), [baseRows]);
  const contentIds = useMemo(
    () => (query.trim() ? ftsMatchIds(db, query) : new Set<string>()),
    [db, query, refreshTick],
  );
  // Fuzzy-search haystack: a session is findable by its task subjects too ("/type checks"
  // hits the session whose plan had that step). Joined once per task-dir change.
  const taskText = useMemo(() => {
    const m = new Map<string, string>();
    for (const id of taskIds) {
      const t = tasksFor(id);
      if (t) m.set(id, t.tasks.map((x) => x.subject).join(" "));
    }
    return m;
  }, [taskIds]);
  const rows = useMemo(() => searchRows(baseRows, query, contentIds, taskText), [baseRows, query, contentIds, taskText]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const id of expandedSessions) map.set(id, childrenOf(db, id));
    return map;
  }, [db, expandedSessions, refreshTick]);
  const items = useMemo(
    () =>
      view === "epic"
        ? buildEpicView(rows, {
            catMap,
            epicMap,
            collapsedSections,
            expandedSessions,
            childCounts: subCounts,
            childrenByParent,
            sort,
            costOf: totalCostFor,
            sectionCostOf: (row) => row.costUSD,
            sectionCost: sectionCostFor,
          })
        : view === "cluster"
        ? buildClusterView(rows, {
            catMap,
            epicMap,
            openSet,
            collapsedSections,
            expandedSessions,
            childCounts: subCounts,
            childrenByParent,
            sort,
            costOf: totalCostFor,
          })
        : view === "groups"
        ? buildGroupsView(rows, { catMap, openSet, collapsedSections, expandedSessions })
        : view === "tree"
        ? buildTreeItems(rows, { catMap, costOf: totalCostFor })
        : view === "state"
          ? buildStateItems(rows, {
              catMap,
              openSet,
              nowMs: Date.now(),
              collapsedSections,
              expandedSessions,
              childCounts: subCounts,
              childrenByParent,
              sort,
              costOf: totalCostFor,
              sectionCostOf: (row) => row.costUSD,
              sectionCost: sectionCostFor,
            })
          : buildDisplayItems(rows, false, {
              expandedSessions,
              childCounts: subCounts,
              childrenByParent,
              sort,
              costOf: totalCostFor,
            }),
    [view, rows, catMap, epicMap, openSet, collapsedSections, expandedSessions, subCounts, childrenByParent, sort, totalCostFor, sectionCostFor],
  );

  const clampedSelected = Math.min(selected, Math.max(0, items.length - 1));
  const current = items[clampedSelected];
  const selectedRow: SessionRow | null = current?.kind === "session" ? current.row : null;
  // Tracks the live selection for the async peek loader, so a slow transcript read that resolves
  // after the cursor has moved on doesn't paint the wrong session's transcript into the pane.
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedRow?.sessionId ?? null;

  const [skeleton, setSkeleton] = useState("");
  useEffect(() => {
    setSkeleton(selectedRow ? getSkeleton(db, selectedRow.sessionId) : "");
  }, [db, selectedRow?.sessionId]);

  // Selecting a different row resets the peek to the top; reuse a cached transcript if we already
  // read this session's file, so scrolling back into it is instant (else fall back to the skeleton).
  useEffect(() => {
    setPeekScroll(0);
    setPeekLines(selectedRow ? peekCache.current.get(selectedRow.sessionId) ?? null : null);
  }, [selectedRow?.sessionId]);

  // Background title drain while open (no-op when nothing needs titling).
  useEffect(() => {
    let alive = true;
    // Engine discovery has a synchronous PATH probe. Start it on a later task, not inside Ink's
    // passive-effect turn, so a rapid mode remount cannot re-enter React's work loop.
    const timer = setTimeout(() => {
      if (!alive) return;
      void backfillTitles(db, titler, {
        concurrency: config.titler.concurrency,
        maxAttempts: config.titler.maxAttempts,
        isCancelled: () => !alive, // stop persisting once the app unmounts (DB is about to close)
        onProgress: (done, total) => {
          if (!alive) return;
          setTitling(done < total ? { done, total } : null);
          reload();
        },
      }).then(
        () => alive && setTitling(null),
        () => alive && setTitling(null),
      );
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [db, titler]);

  // Spinner animation — while titling or while a Codex command is in flight.
  const spinning = !!titling || !!command?.busy;
  useEffect(() => {
    if (!spinning) return;
    const id = setInterval(() => setFrame((f) => f + 1), 110);
    return () => clearInterval(id);
  }, [spinning]);

  const move = (delta: number) =>
    setSelected((s) => Math.max(0, Math.min(s + delta, items.length - 1)));

  const toggleSection = (key: string, collapse?: boolean) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      // `:done` folds invert the default (collapsed unless an `open:` marker is present),
      // so toggling them flips the marker instead of the key. Everything else: presence = collapsed.
      if (key.endsWith(":done")) {
        const marker = `open:${key}`;
        const isOpen = next.has(marker);
        const shouldCollapse = collapse ?? isOpen;
        if (shouldCollapse) next.delete(marker);
        else next.add(marker);
        return next;
      }
      const shouldCollapse = collapse ?? !next.has(key);
      if (shouldCollapse) next.add(key);
      else next.delete(key);
      return next;
    });

  const toggleSessionExpand = (open: boolean) => {
    const item = items[clampedSelected];
    if (item?.kind === "section") {
      toggleSection(item.section.key, !open);
      return;
    }
    if (!item || item.kind !== "session") return;
    // Expandable if the row has children in the current view (subagent runs, or constellation
    // children in the groups/tree views). item.childCount reflects whichever the view provides.
    if (item.childCount === 0) return;
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (open) next.add(item.row.sessionId);
      else next.delete(item.row.sessionId);
      return next;
    });
  };

  const doResume = (fork: boolean, forceOther: boolean, via?: Launcher, rowOverride?: SessionRow) => {
    const item = items[clampedSelected];
    const r = rowOverride ?? (item?.kind === "session" ? item.row : null);
    if (!r) return;
    if (r.isSubagent) {
      setStatus("subagent runs aren't resumable — they're task runs spawned by a parent session");
      return;
    }
    // If the session is already live, FOCUS its existing tab instead of spawning a duplicate
    // (ADR-0040: exact session→surface→workspace resolution). Enter = "take me to it".
    if (openSet.has(r.sessionId) || openSet.has(r.resumeId)) {
      const focused = focusSession(r.sessionId);
      setStatus(focused ? `switched to → ${r.title}` : `already open, but couldn't switch to ${r.title}`);
      return;
    }
    // Cross-backend route: an explicit pick from the `r` overlay wins; plain enter takes the
    // origin-backend default from the session's model history (pure-gpt → the gpt launcher).
    const launcher = via ?? defaultRoute(resolveRoutes(launchers, r.models), r.models)?.launcher;
    if (!launcher) {
      setStatus(`no configured launcher can replay [${r.models.join(", ")}] — check [[launcher]] serves globs`);
      return;
    }
    const viaSuffix = launcher.name !== "claude" ? ` via ${launcher.name}` : "";
    const cwdResult = resolveResumeCwd(r);
    if ("error" in cwdResult) {
      setStatus(`can't resume: ${cwdResult.error}`);
      return;
    }
    const { cwd, note } = cwdResult;
    const cmd = buildResumeCommand(r, { fork, cwd, binary: launcher.binary, env: launcher.env });
    const target = resolveTarget(config.resume.target, reachable, forceOther);
    const prefix = note ? `${note} · ` : "";
    if (target === "cmux") {
      // Route through the shared resume core (resumeSessionEntry) so the TUI gets the SAME
      // behavior as `ccs resume`: resume_command replay (loops come back running), the
      // ADR-0042 env-scrub, and EAGER tab paint — no divergent second spawn path. `focus:true`
      // because an interactive resume wants to land in the pane. A fork has no catalogue
      // resume_command to replay, and the core doesn't fork, so keep the direct path for forks.
      if (catalogue && !fork) {
        const res = resumeSessionEntry(db, catalogue, r.sessionId, {
          focus: true,
          via: launcher.name,
          launchers,
        });
        const ok = res.status === "resumed" || res.status === "already-open";
        const fail =
          res.status === "route-ineligible"
            ? `route ineligible: ${res.reason}`
            : "cmux failed — press o to resume inline";
        setStatus(prefix + (ok ? `opened in cmux${viaSuffix} → ${r.title}` : fail));
      } else {
        const ok = openInCmux(cmd, r.title);
        setStatus(prefix + (ok ? `opened in cmux${viaSuffix} → ${r.title}${fork ? " (fork)" : ""}` : "cmux failed — press o to resume inline"));
      }
    } else {
      resumeRequest.current = cmd;
      exit();
    }
  };

  // Open the `r` overlay on the selected session: summary of what you'd be resuming + one row
  // per configured launcher. Live sessions still open it (informational) — enter focuses.
  const openRoutePicker = () => {
    const item = items[clampedSelected];
    if (!item || item.kind !== "session") return;
    const r = item.row;
    if (r.isSubagent) {
      setStatus("subagent runs aren't resumable — they're task runs spawned by a parent session");
      return;
    }
    const routes = resolveRoutes(launchers, r.models);
    const def = defaultRoute(routes, r.models);
    const defIdx = def ? routes.findIndex((rt) => rt.launcher.name === def.launcher.name) : 0;
    setRoutePicker({
      row: r,
      routes,
      selected: Math.max(0, defIdx),
      live: openSet.has(r.sessionId) || openSet.has(r.resumeId),
    });
  };

  /** Move the picker highlight to the next ELIGIBLE route in `dir`, wrapping. */
  const moveRoutePicker = (dir: 1 | -1) =>
    setRoutePicker((p) => {
      if (!p) return p;
      const n = p.routes.length;
      let i = p.selected;
      for (let step = 0; step < n; step++) {
        i = (i + dir + n) % n;
        if (p.routes[i]!.eligible) return { ...p, selected: i };
      }
      return p;
    });

  const activate = () => {
    const item = items[clampedSelected];
    if (!item) return;
    if (item.kind === "section") {
      toggleSection(item.section.key);
      return;
    }
    if (item.kind === "session") doResume(false, false);
  };

  const openTranscript = () => {
    const item = items[clampedSelected];
    if (!item || item.kind !== "session") return;
    const r = item.row;
    setStatus(`Loading transcript for "${r.title}"…`);
    void readTranscript(r.path).then(({ lines, truncated }) => {
      setTranscript({ title: r.title, lines, truncated, scroll: 0 });
      setStatus(null);
    });
  };

  const scrollTranscript = (delta: number) =>
    setTranscript((t) => (t ? { ...t, scroll: Math.max(0, t.scroll + delta) } : t));

  // Scroll the preview peek by ~half its visible height. The first scroll lazily reads the real
  // transcript (cached per session); until then the peek shows the baked skeleton. Overshoot is
  // clamped inside the pane, so a coarse step still lands exactly on END.
  const scrollPeek = (dir: -1 | 1) => {
    if (!selectedRow || !previewVisible) return;
    const step = Math.max(1, Math.floor((previewHeight - 10) / 2));
    if (peekLines) {
      setPeekScroll((s) => Math.max(0, s + dir * step));
      return;
    }
    const id = selectedRow.sessionId;
    const land = () => setPeekScroll(dir > 0 ? step : 0);
    const cached = peekCache.current.get(id);
    if (cached) {
      setPeekLines(cached);
      land();
      return;
    }
    void readTranscript(selectedRow.path).then(({ lines }) => {
      peekCache.current.set(id, lines);
      if (selectedIdRef.current === id) {
        setPeekLines(lines);
        land();
      }
    });
  };

  const retitle = () => {
    const item = items[clampedSelected];
    if (!item || item.kind !== "session") return;
    const r = item.row;
    setStatus(`Re-titling "${r.title}"…`);
    void titler.generate(getSkeleton(db, r.sessionId)).then((t) => {
      if (t) {
        saveCodexTitle(db, r.sessionId, t);
        setStatus(`Re-titled → ${t}`);
        reload();
      } else {
        setStatus("Re-title failed.");
      }
    });
  };

  // Run a natural-language metadata command through Codex and apply the result live.
  const submitCommand = (scope: "all" | "session", buffer: string) => {
    if (!catalogue || !buffer.trim()) {
      setCommand(null);
      return;
    }
    const focus = scope === "session" ? selectedRow?.sessionId ?? null : null;
    const sessions: SessionMeta[] = baseRows.map((r) => {
      const c = catMap.get(r.sessionId);
      return {
        sessionId: r.sessionId,
        title: r.title,
        kind: c?.kind ?? "session",
        skill: c?.skill ?? null,
        key: identityKeyOf(c),
        parentSessionId: c?.parentSessionId ?? null,
        completed: !!c?.completed,
        archived: !!c?.archived,
        project: c?.project ?? null,
        repo: r.projectName,
      };
    });
    if (!engine) {
      setCommand(null);
      setStatus("no inference engine (codex/claude) found on PATH");
      return;
    }
    setCommand({ scope, buffer, busy: true });
    setStatus(`${scope === "session" ? "editing session" : "reorganizing"} — asking ${engine.name}…`);
    void runMetadataCommand(buffer, sessions, focus, engine).then((res) => {
      setCommand(null);
      if ("error" in res) {
        setStatus(`command failed (${res.error})`);
        return;
      }
      if (res.mutations.length === 0) {
        setStatus("codex proposed no changes");
        return;
      }
      const summary = applyMutations(catalogue, res.mutations, new Date().toISOString());
      setStatus(`✓ ${summary}`);
      reload();
    });
  };

  // Apply a catalogue mutation to the selected session, then refresh. No-op on
  // headers/subagents or when no catalogue is mounted.
  const applyMark = (mut: (cat: Database, id: string, now: string) => void, msg: string) => {
    const item = items[clampedSelected];
    if (!item || item.kind !== "session" || item.row.isSubagent || !catalogue) return;
    mut(catalogue, item.row.sessionId, new Date().toISOString());
    setStatus(msg);
    reload();
  };

  useInput((input, key) => {
    // Transcript viewer owns input while open.
    if (transcript) {
      const page = Math.max(1, termRows - 6);
      if (key.escape || input === "q" || input === "v") setTranscript(null);
      else if (key.upArrow || input === "k") scrollTranscript(-1);
      else if (key.downArrow || input === "j") scrollTranscript(1);
      else if (key.pageUp) scrollTranscript(-page);
      else if (key.pageDown || input === " ") scrollTranscript(page);
      else if (input === "g") scrollTranscript(-1_000_000);
      else if (input === "G") scrollTranscript(1_000_000);
      return;
    }

    // Route picker owns input while open.
    if (routePicker) {
      const chosen = routePicker.routes[routePicker.selected];
      if (key.escape || input === "q" || input === "r") setRoutePicker(null);
      else if (key.upArrow || input === "k") moveRoutePicker(-1);
      else if (key.downArrow || input === "j") moveRoutePicker(1);
      else if (key.return && routePicker.live) {
        // Live tab: enter = focus (doResume's live guard handles it; route is irrelevant).
        setRoutePicker(null);
        doResume(false, false, undefined, routePicker.row);
      } else if ((key.return || input === "f" || input === "o") && chosen?.eligible) {
        setRoutePicker(null);
        doResume(input === "f", input === "o", chosen.launcher, routePicker.row);
      }
      return;
    }

    if (searching) {
      if (key.escape) {
        setSearching(false);
        setQuery("");
      } else if (key.return) {
        setSearching(false);
      } else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
      } else if (key.upArrow) {
        move(-1);
      } else if (key.downArrow) {
        move(1);
      } else if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
      }
      return;
    }

    // Natural-language command input owns the keyboard while composing (ignored while Codex runs).
    if (command) {
      if (command.busy) return;
      if (key.escape) setCommand(null);
      else if (key.return) submitCommand(command.scope, command.buffer);
      else if (key.backspace || key.delete) setCommand({ ...command, buffer: command.buffer.slice(0, -1) });
      else if (input && !key.ctrl && !key.meta) setCommand({ ...command, buffer: command.buffer + input });
      return;
    }

    if (input === "?") {
      setShowHelp((v) => !v);
      return;
    }
    if (showHelp) {
      if (key.escape || input === "q" || input === "?") setShowHelp(false);
      return;
    }

    // esc backs out one level: search filter → skills-mode pin → quit.
    if (key.escape) {
      if (query) {
        setQuery("");
        setSelected(0);
      } else if (pinned && onClearPinned) {
        onClearPinned();
        setSelected(0);
      } else {
        exit();
      }
      return;
    }
    if (key.tab && onSwitchMode) {
      onSwitchMode();
      return;
    }
    if (input === "q") exit();
    else if (key.upArrow || input === "k") move(-1);
    else if (key.downArrow || input === "j") move(1);
    else if (key.rightArrow || input === "l") toggleSessionExpand(true);
    else if (key.leftArrow || input === "h") toggleSessionExpand(false);
    else if (input === "/") {
      setStatus(null);
      setSearching(true);
    } else if (input === ":") {
      if (catalogue) {
        setStatus(null);
        setCommand({ scope: "all", buffer: "", busy: false });
      }
    } else if (input === "e") {
      if (catalogue && selectedRow) {
        setStatus(null);
        setCommand({ scope: "session", buffer: "", busy: false });
      }
    } else if (input === "g") {
      setView((v) => VIEW_CYCLE[(VIEW_CYCLE.indexOf(v) + 1) % VIEW_CYCLE.length]!);
      setSelected(0);
    } else if (input === "s") {
      setSort((s) => SORT_CYCLE[(SORT_CYCLE.indexOf(s) + 1) % SORT_CYCLE.length]!);
      setSelected(0);
    } else if (input === "p") setPreviewVisible((v) => !v);
    else if (input === "d") {
      if (selectedRow) setDetailsOpen((v) => !v);
    } else if (input === "J") scrollPeek(1);
    else if (input === "K") scrollPeek(-1);
    else if (input === "v") openTranscript();
    else if (input === "a") {
      setIncludeSubagents((v) => !v);
      setSelected(0);
    } else if (input === "t") retitle();
    else if (input === "i") {
      // Swap the inference engine (only meaningful when both codex + claude are installed).
      if (availableEngines.length < 2) {
        setStatus(availableEngines.length === 1 ? `only ${availableEngines[0]} installed` : "no inference engine installed");
      } else {
        const next = availableEngines[(availableEngines.indexOf(activeEngine!) + 1) % availableEngines.length]!;
        cycleEngine();
        setStatus(`inference engine → ${next}`);
      }
    } else if (input === "C")
      applyMark((c, id, now) => setCompleted(c, id, !catMap.get(id)?.completed, now), "toggled completed");
    else if (input === "X")
      applyMark((c, id, now) => setArchived(c, id, !catMap.get(id)?.archived, now), "toggled archived");
    else if (input === "A") {
      setShowArchived((v) => !v);
      setSelected(0);
    } else if (input === "u") {
      // `u` is the explicit user-selected auxiliary visibility toggle. It is independent from
      // native subagent visibility (`a`) and always resets on a fresh TUI mount.
      setShowAuxiliary((visible) => !visible);
      setSelected(0);
    } else if (input === "U") {
      setTaskFilter((f) => {
        const next = TASK_FILTER_CYCLE[(TASK_FILTER_CYCLE.indexOf(f) + 1) % TASK_FILTER_CYCLE.length]!;
        setStatus(
          next === "all"
            ? "tasks: all sessions"
            : next === "open"
              ? "tasks: sessions with unfinished tasks"
              : "tasks: interrupted mid-task only",
        );
        return next;
      });
      setSelected(0);
    } else if (input === "f") doResume(true, false);
    else if (input === "o") doResume(false, true);
    else if (input === "r") openRoutePicker();
    else if (key.return) activate();
  });

  // ---- Layout (recomputed on every resize via useTerminalSize) ----
  const listMode = !transcript && !showHelp && !routePicker;
  // Chrome = header (2) + footer (1) + rule under header (list mode only) + optional search/status.
  const chrome = 3 + (listMode ? 1 : 0) + (searching ? 1 : 0) + (command ? 1 : 0) + (status ? 1 : 0);
  const body = Math.max(3, termRows - chrome);
  const contentWidth = cols - 2; // outer paddingX={1}

  // The preview pane is ALWAYS reserved when visible — it never collapses on section focus, so the
  // list width (and thus every column) stays put regardless of what row the cursor is on.
  const showPreviewPane = previewVisible && listMode && items.length > 0;
  const sideBySide = cols >= 100 && showPreviewPane;
  const previewWidth = sideBySide ? Math.min(58, Math.max(40, Math.floor(cols * 0.42))) : 0;
  const listWidth = sideBySide ? Math.max(20, contentWidth - previewWidth - 1) : contentWidth;
  const previewHeightStacked = Math.min(Math.max(8, Math.floor(body * 0.4)), 16);
  const stackedListRows = sideBySide ? body : showPreviewPane ? Math.max(3, body - previewHeightStacked) : body;
  const listHeight = Math.max(1, stackedListRows - 1); // 1 row for the column header inside the list column
  const previewHeight = sideBySide ? body : previewHeightStacked;
  const spin = SPINNER[frame % SPINNER.length];

  const selSection = current?.kind === "section" ? current : null;
  const selectedCost = selectedRow ? costRollup.bySessionId.get(selectedRow.sessionId) : undefined;
  const selectedCatalogue = selectedRow ? catMap.get(selectedRow.sessionId) : undefined;
  const previewEl = selectedRow ? (
    <Preview
      row={selectedRow}
      skeleton={skeleton}
      parentTitle={(() => {
        const parentId = selectedRow.parentSessionId ?? selectedCatalogue?.parentSessionId ?? null;
        return parentId ? titleById.get(parentId) ?? parentId : null;
      })()}
      descendantCount={selectedCost?.descendantCount ?? 0}
      selfCost={selectedCost?.selfCost ?? selectedRow.costUSD}
      totalCost={selectedCost?.totalCost ?? selectedRow.costUSD}
      providerCost={selectedCost?.byProvider ?? { claude: 0, gpt: 0, other: selectedRow.costUSD }}
      event={identityKeyOf(catMap.get(selectedRow.sessionId) ?? null)}
      skill={catMap.get(selectedRow.sessionId)?.skill ?? null}
      project={catMap.get(selectedRow.sessionId)?.project ?? null}
      kind={selectedCatalogue?.kind}
      sessionClass={selectedCatalogue?.sessionClass ?? null}
      system={selectedCatalogue?.system ?? null}
      gusWork={catMap.get(selectedRow.sessionId)?.gusWork ?? null}
      gusWorkSfId={(catMap.get(selectedRow.sessionId)?.meta?.gus_work_sf_id as string | undefined) ?? null}
      prNumber={catMap.get(selectedRow.sessionId)?.prNumber ?? null}
      prRepo={catMap.get(selectedRow.sessionId)?.prRepo ?? null}
      prState={catMap.get(selectedRow.sessionId)?.prState ?? null}
      epicName={epicMap.get(catMap.get(selectedRow.sessionId)?.groupingId ?? "")?.name ?? null}
      epicUrl={epicMap.get(catMap.get(selectedRow.sessionId)?.groupingId ?? "")?.url ?? null}
      reviewAppUrl={(() => {
        const key = catMap.get(selectedRow.sessionId)?.identityKey;
        const attrs = key ? identityAttrsMap.get(key) : null;
        const url = attrs?.review_app_url;
        return typeof url === "string" && url.startsWith("http") ? url : null;
      })()}
      tasks={taskIds.has(selectedRow.sessionId) ? tasksFor(selectedRow.sessionId) : null}
      height={previewHeight}
      width={sideBySide ? previewWidth : contentWidth}
      detailsOpen={detailsOpen}
      peekLines={peekLines}
      peekScroll={peekScroll}
    />
  ) : selSection ? (
    <SectionCard
      name={selSection.section.name}
      glyph={selSection.section.glyph}
      count={selSection.count}
      cost={selSection.cost}
      sectionKey={selSection.section.key}
      height={previewHeight}
      width={sideBySide ? previewWidth : contentWidth}
    />
  ) : null;

  // The task column earns its 8 cells only when the LIST is wide enough to keep a readable
  // title next to the fixed columns (cluster view carries PHASE+ROLE too, so it needs more).
  // Narrow lists keep just the interrupted `!` marker on the title row; the preview pane
  // always has the full task list regardless.
  const showTasksCol = listWidth >= (view === "cluster" ? 100 : 80);
  const listCol = (w: number) => (
    <Box flexDirection="column">
      <ListHeader sort={sort} view={view} showTasks={showTasksCol} />
      <SessionList items={items} selected={clampedSelected} height={listHeight} width={w} deco={deco} totalCost={totalCostById} showRoleStatus={view === "cluster"} showTasks={showTasksCol} />
    </Box>
  );

  return (
    <Box flexDirection="column" width={cols} paddingX={1}>
      <Header
        stats={stats}
        sort={sort}
        filter={query && !searching ? query : pinned ? `⚙${pinned.label} sessions — esc back to skills` : null}
        titling={titling ? `${spin} titling ${titling.done}/${titling.total}` : null}
      />
      {listMode ? <Text color={theme.headerBorder}>{"─".repeat(Math.max(0, contentWidth))}</Text> : null}

      {searching ? (
        <Box>
          <Text color="yellow">/ </Text>
          <Text>{query}</Text>
          <Text color={theme.accent}>▏</Text>
        </Box>
      ) : null}

      {command ? (
        <Box>
          <Text color={theme.accent} bold>
            {command.busy ? `${spin} ` : command.scope === "session" ? "edit› " : "codex› "}
          </Text>
          <Text color={command.scope === "session" ? theme.project : theme.title}>
            {command.scope === "session" && selectedRow ? `«${selectedRow.title}» ` : ""}
          </Text>
          <Text>{command.buffer}</Text>
          {command.busy ? null : <Text color={theme.accent}>▏</Text>}
        </Box>
      ) : null}

      {routePicker ? (
        <RoutePicker
          row={routePicker.row}
          routes={routePicker.routes}
          defaultName={defaultRoute(routePicker.routes, routePicker.row.models)?.launcher.name ?? null}
          selected={routePicker.selected}
          live={routePicker.live}
          target={resolveTarget(config.resume.target, reachable, false)}
        />
      ) : transcript ? (
        <Transcript
          title={transcript.title}
          lines={transcript.lines}
          truncated={transcript.truncated}
          scroll={transcript.scroll}
          width={cols}
          height={body}
        />
      ) : showHelp ? (
        <Help />
      ) : items.length === 0 ? (
        <Box height={body} alignItems="center" justifyContent="center">
          <Text color={theme.muted}>
            {query
              ? "No sessions match — esc to clear search"
              : view === "tree"
                ? "No parent/child constellation among these sessions — g to switch view"
                : "No sessions indexed yet."}
          </Text>
        </Box>
      ) : sideBySide ? (
        <Box flexDirection="row" height={body}>
          <Box width={listWidth} flexShrink={0} marginRight={1}>
            {listCol(listWidth)}
          </Box>
          <Box width={previewWidth} flexShrink={0}>
            {previewEl}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {listCol(contentWidth)}
          {showPreviewPane ? previewEl : null}
        </Box>
      )}

      {status && !transcript ? (
        <Text color="magenta" wrap="truncate-end">
          {status}
        </Text>
      ) : null}

      {transcript ? null : (
        <KeyBar
          items={[
            ["enter", "resume"],
            ["r", "resume via…"],
            ["/", "search"],
            ["v", "transcript"],
            ["g", `view:${view}`],
            ...(taskFilter !== "all" ? [["u", `tasks:${taskFilter}`] as [string, string]] : []),
            ["Tab", "skills"],
            // Only surface the engine key when there's actually another engine to swap to.
            ...(availableEngines.length > 1 ? [["i", `ai:${activeEngine}`] as [string, string]] : []),
            ["?", "all keys"],
          ]}
        />
      )}
    </Box>
  );
}
