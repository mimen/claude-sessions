import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { useTerminalSize } from "./useTerminalSize.ts";
import type { Database } from "bun:sqlite";
import type { Config } from "../config.ts";
import type { Titler } from "../titler/codex.ts";
import {
  listByRecency,
  ftsMatchIds,
  getSkeleton,
  subagentCounts,
  subagentCosts,
  childrenOf,
  saveCodexTitle,
  type SessionRow,
} from "../index/index.ts";
import { backfillTitles } from "../titler/queue.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "../resume/command.ts";
import { resolveTarget, cmuxReachableAsync } from "../resume/target.ts";
import { openInCmux } from "../resume/cmux.ts";
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
import { getAll, lifecycleOf, setKind, setCompleted, setArchived, setCustomTitle, identityKeyOf } from "../catalogue/db.ts";
import { openSessionTitlesAsync } from "../catalogue/open-state.ts";
import { runMetadataCommand, applyMutations, type SessionMeta } from "../catalogue/command.ts";
import { buildStateItems, DEFAULT_COLLAPSED } from "./stateGroups.ts";
import { buildTreeItems } from "./treeGroups.ts";
import { buildGroupsView } from "./groupsView.ts";
import { buildClusterView } from "./clusterView.ts";

const SORT_CYCLE: SortMode[] = ["recent", "cost", "msgs"];
type View = "groups" | "state" | "flat" | "tree" | "cluster";
const VIEW_CYCLE: View[] = ["groups", "state", "flat", "tree", "cluster"];

const STALE_MS = 14 * 24 * 60 * 60 * 1000;

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
}

interface AppProps {
  db: Database;
  config: Config;
  titler: Titler;
  /** Durable user metadata. Optional so tests can mount without a catalogue (no cmux probe). */
  catalogue?: Database;
  /** Inline resume is handed back to the launcher here, after the app exits. */
  resumeRequest: { current: ResumeCommand | null };
  /** Tab-toggle to the skills panel (provided by Root; absent in tests). */
  onSwitchMode?: () => void;
  /** Cross-jump pin from skills mode: only sessions whose transcript path is in the set. */
  pinned?: { paths: ReadonlySet<string>; label: string } | null;
  onClearPinned?: () => void;
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function App({ db, catalogue, config, titler, resumeRequest, onSwitchMode, pinned, onClearPinned }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns: cols, rows: termRows } = useTerminalSize();

  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  // Natural-language metadata command (Codex-backed). scope "all" = whole catalogue; "session" =
  // the selected row. busy = a Codex call is in flight.
  const [command, setCommand] = useState<{ scope: "all" | "session"; buffer: string; busy: boolean } | null>(null);
  const [view, setView] = useState<View>("groups");
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

  const reload = () => setRefreshTick((t) => t + 1);
  // cmux probes must be ASYNC in the TUI. In render they block React mid-frame; even in an
  // effect a sync spawn blocks the event loop and re-enters the work loop ("Should not
  // already be working." — the Tab-between-modes crash, since every toggle remounts App).
  const [reachable, setReachable] = useState(false);
  useEffect(() => {
    let alive = true;
    void cmuxReachableAsync().then((v) => alive && setReachable(v));
    return () => {
      alive = false;
    };
  }, []);

  // Catalogue join: custom-title override + lifecycle; live open-state from cmux. Only when a
  // catalogue is present (tests mount without one, so no cmux probe runs there).
  const catMap = useMemo(
    () => (catalogue ? getAll(catalogue) : new Map()),
    [catalogue, refreshTick],
  );
  // Live cmux workspace titles (source of truth for open sessions) — override the ccs Title while
  // open. Also gives us the open-set (its keys) so we probe cmux once, not twice.
  const [openTitles, setOpenTitles] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!catalogue) return;
    let alive = true;
    void openSessionTitlesAsync().then((titles) => alive && setOpenTitles(titles));
    return () => {
      alive = false;
    };
  }, [catalogue, refreshTick]);
  const openSet = useMemo(() => new Set(openTitles.keys()), [openTitles]);
  const baseRows = useMemo(() => {
    const raw = listByRecency(db, includeSubagents);
    return raw
      .filter((r) => !pinned || pinned.paths.has(r.path))
      .filter((r) => showArchived || lifecycleOf(catMap.get(r.sessionId) ?? null) !== "archived")
      .map((r) => {
        // Precedence: live cmux title (open) → user's custom title → resolved Title.
        const title = openTitles.get(r.sessionId) ?? catMap.get(r.sessionId)?.customTitle ?? r.title;
        return title === r.title ? r : { ...r, title };
      });
  }, [db, includeSubagents, refreshTick, catMap, showArchived, openTitles]);

  // Write-through: persist an open session's cmux title into the catalogue so the name stays put
  // after the tab closes (cmux is the source of truth, tightly linked). Only writes on a change.
  useEffect(() => {
    if (!catalogue) return;
    const now = new Date().toISOString();
    let changed = false;
    for (const [sid, title] of openTitles) {
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
      m.set(r.sessionId, {
        glyph, color, nudge,
        event: identityKeyOf(c),
        pr: c?.prNumber ?? null,
        prState: c?.prState ?? null,
      });
    }
    return m;
  }, [baseRows, catMap, openSet]);
  const subCounts = useMemo(() => subagentCounts(db), [db, refreshTick]);
  // A parent's subagent runs key on its INTERNAL id (= resumeId); match both to be safe.
  const subCostMap = useMemo(() => subagentCosts(db), [db, refreshTick]);
  const totalCostFor = React.useCallback(
    (r: SessionRow): number =>
      r.costUSD + (subCostMap.get(r.sessionId) ?? subCostMap.get(r.resumeId) ?? 0),
    [subCostMap],
  );
  const totalCostById = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of baseRows) m.set(r.sessionId, totalCostFor(r));
    return m;
  }, [baseRows, totalCostFor]);
  const stats = useMemo<DashStats>(() => {
    let spend = 0,
      active = 0,
      parked = 0,
      loops = 0,
      loopSpend = 0;
    let topTitle: string | null = null;
    let topCost = 0;
    for (const r of baseRows) {
      const c = catMap.get(r.sessionId) ?? null;
      const total = totalCostFor(r);
      spend += total;
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
    for (const usd of subCostMap.values()) agentSpend += usd;
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
  }, [baseRows, catMap, openSet, subCostMap, totalCostFor, config.host.label]);
  const titleById = useMemo(() => new Map(baseRows.map((r) => [r.sessionId, r.title])), [baseRows]);
  const contentIds = useMemo(
    () => (query.trim() ? ftsMatchIds(db, query) : new Set<string>()),
    [db, query, refreshTick],
  );
  const rows = useMemo(() => searchRows(baseRows, query, contentIds), [baseRows, query, contentIds]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, SessionRow[]>();
    for (const id of expandedSessions) map.set(id, childrenOf(db, id));
    return map;
  }, [db, expandedSessions, refreshTick]);
  const items = useMemo(
    () =>
      view === "cluster"
        ? buildClusterView(rows, {
            catMap,
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
            })
          : buildDisplayItems(rows, false, {
              expandedSessions,
              childCounts: subCounts,
              childrenByParent,
              sort,
              costOf: totalCostFor,
            }),
    [view, rows, catMap, openSet, collapsedSections, expandedSessions, subCounts, childrenByParent, sort, totalCostFor],
  );

  const clampedSelected = Math.min(selected, Math.max(0, items.length - 1));
  const current = items[clampedSelected];
  const selectedRow: SessionRow | null = current?.kind === "session" ? current.row : null;

  const [skeleton, setSkeleton] = useState("");
  useEffect(() => {
    setSkeleton(selectedRow ? getSkeleton(db, selectedRow.sessionId) : "");
  }, [db, selectedRow?.sessionId]);

  // Background title drain while open (no-op when nothing needs titling).
  useEffect(() => {
    let alive = true;
    void backfillTitles(db, titler, {
      concurrency: config.titler.concurrency,
      maxAttempts: config.titler.maxAttempts,
      isCancelled: () => !alive, // stop persisting once the app unmounts (DB is about to close)
      onProgress: (done, total) => {
        if (!alive) return;
        setTitling(done < total ? { done, total } : null);
        reload();
      },
    }).then(() => alive && setTitling(null));
    return () => {
      alive = false;
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

  const doResume = (fork: boolean, forceOther: boolean) => {
    const item = items[clampedSelected];
    if (!item || item.kind !== "session") return;
    const r = item.row;
    if (r.isSubagent) {
      setStatus("subagent runs aren't resumable — they're task runs spawned by a parent session");
      return;
    }
    const { cwd, note } = resolveResumeCwd(r);
    const cmd = buildResumeCommand(r, { fork, cwd });
    const target = resolveTarget(config.resume.target, reachable, forceOther);
    const prefix = note ? `${note} · ` : "";
    if (target === "cmux") {
      const ok = openInCmux(cmd, r.title);
      setStatus(prefix + (ok ? `opened in cmux → ${r.title}${fork ? " (fork)" : ""}` : "cmux failed — press o to resume inline"));
    } else {
      resumeRequest.current = cmd;
      exit();
    }
  };

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
        event: identityKeyOf(c),
        parentSessionId: c?.parentSessionId ?? null,
        completed: !!c?.completed,
        archived: !!c?.archived,
        project: c?.project ?? null,
        repo: r.projectName,
      };
    });
    setCommand({ scope, buffer, busy: true });
    setStatus(`${scope === "session" ? "editing session" : "reorganizing"} — asking codex…`);
    void runMetadataCommand(buffer, sessions, focus, {
      binary: config.titler.binary,
      model: config.titler.model,
      reasoningEffort: config.titler.reasoningEffort,
    }).then((res) => {
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
    else if (input === "v") openTranscript();
    else if (input === "a") {
      setIncludeSubagents((v) => !v);
      setSelected(0);
    } else if (input === "t") retitle();
    else if (input === "L")
      applyMark(
        (c, id, now) => setKind(c, id, catMap.get(id)?.kind === "loop" ? "session" : "loop", now),
        "toggled loop",
      );
    else if (input === "C")
      applyMark((c, id, now) => setCompleted(c, id, !catMap.get(id)?.completed, now), "toggled completed");
    else if (input === "X")
      applyMark((c, id, now) => setArchived(c, id, !catMap.get(id)?.archived, now), "toggled archived");
    else if (input === "A") {
      setShowArchived((v) => !v);
      setSelected(0);
    } else if (input === "f") doResume(true, false);
    else if (input === "o") doResume(false, true);
    else if (key.return) activate();
  });

  // ---- Layout (recomputed on every resize via useTerminalSize) ----
  const listMode = !transcript && !showHelp;
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
  const previewEl = selectedRow ? (
    <Preview
      row={selectedRow}
      skeleton={skeleton}
      parentTitle={
        selectedRow.parentSessionId
          ? titleById.get(selectedRow.parentSessionId) ?? selectedRow.parentSessionId
          : null
      }
      subagentCount={subCounts.get(selectedRow.sessionId) ?? 0}
      subagentCost={
        subCostMap.get(selectedRow.sessionId) ?? subCostMap.get(selectedRow.resumeId) ?? 0
      }
      event={identityKeyOf(catMap.get(selectedRow.sessionId) ?? null)}
      skill={catMap.get(selectedRow.sessionId)?.skill ?? null}
      project={catMap.get(selectedRow.sessionId)?.project ?? null}
      kind={catMap.get(selectedRow.sessionId)?.kind}
      system={catMap.get(selectedRow.sessionId)?.system ?? null}
      gusWork={catMap.get(selectedRow.sessionId)?.gusWork ?? null}
      prNumber={catMap.get(selectedRow.sessionId)?.prNumber ?? null}
      prRepo={catMap.get(selectedRow.sessionId)?.prRepo ?? null}
      prState={catMap.get(selectedRow.sessionId)?.prState ?? null}
      height={previewHeight}
    />
  ) : selSection ? (
    <SectionCard
      name={selSection.section.name}
      glyph={selSection.section.glyph}
      count={selSection.count}
      cost={selSection.cost}
      sectionKey={selSection.section.key}
      height={previewHeight}
    />
  ) : null;

  const listCol = (w: number) => (
    <Box flexDirection="column">
      <ListHeader sort={sort} view={view} />
      <SessionList items={items} selected={clampedSelected} height={listHeight} width={w} deco={deco} totalCost={totalCostById} />
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

      {transcript ? (
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
            ["/", "search"],
            ["v", "transcript"],
            ["g", `view:${view}`],
            ["Tab", "skills"],
            ["?", "all keys"],
          ]}
        />
      )}
    </Box>
  );
}
