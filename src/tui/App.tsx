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
  childrenOf,
  saveCodexTitle,
  type SessionRow,
} from "../index/index.ts";
import { backfillTitles } from "../titler/queue.ts";
import { buildResumeCommand, resolveResumeCwd, type ResumeCommand } from "../resume/command.ts";
import { resolveTarget, cmuxReachable } from "../resume/target.ts";
import { openInCmux } from "../resume/cmux.ts";
import { searchRows } from "./search.ts";
import { buildDisplayItems } from "./groupByProject.ts";
import { SessionList } from "./SessionList.tsx";
import { Preview } from "./Preview.tsx";
import { Help } from "./Help.tsx";
import { theme } from "./theme.ts";

interface AppProps {
  db: Database;
  config: Config;
  titler: Titler;
  /** Inline resume is handed back to the launcher here, after the app exits. */
  resumeRequest: { current: ResumeCommand | null };
}

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

export function App({ db, config, titler, resumeRequest }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { columns: cols, rows: termRows } = useTerminalSize();

  const [includeSubagents, setIncludeSubagents] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [grouped, setGrouped] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [expandedSessions, setExpandedSessions] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [titling, setTitling] = useState<{ done: number; total: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  const reload = () => setRefreshTick((t) => t + 1);
  const reachable = useMemo(() => cmuxReachable(), []);

  const baseRows = useMemo(
    () => listByRecency(db, includeSubagents),
    [db, includeSubagents, refreshTick],
  );
  const subCounts = useMemo(() => subagentCounts(db), [db, refreshTick]);
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
      buildDisplayItems(rows, grouped, {
        expandedGroups: expanded,
        expandedSessions,
        childCounts: subCounts,
        childrenByParent,
      }),
    [rows, grouped, expanded, expandedSessions, subCounts, childrenByParent],
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

  // Spinner animation, only while titling.
  useEffect(() => {
    if (!titling) return;
    const id = setInterval(() => setFrame((f) => f + 1), 110);
    return () => clearInterval(id);
  }, [titling]);

  const move = (delta: number) =>
    setSelected((s) => Math.max(0, Math.min(s + delta, items.length - 1)));

  const toggleSessionExpand = (open: boolean) => {
    const item = items[clampedSelected];
    if (!item || item.kind !== "session") return;
    if ((subCounts.get(item.row.sessionId) ?? 0) === 0) return;
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
    if (item.kind === "header") {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(item.group.root)) next.delete(item.group.root);
        else next.add(item.group.root);
        return next;
      });
    } else {
      doResume(false, false);
    }
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

  useInput((input, key) => {
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

    if (input === "?") {
      setShowHelp((v) => !v);
      return;
    }
    if (showHelp) {
      if (key.escape || input === "q") setShowHelp(false);
      return;
    }

    if (input === "q" || key.escape) exit();
    else if (key.upArrow || input === "k") move(-1);
    else if (key.downArrow || input === "j") move(1);
    else if (key.rightArrow || input === "l") toggleSessionExpand(true);
    else if (key.leftArrow || input === "h") toggleSessionExpand(false);
    else if (input === "/") {
      setStatus(null);
      setSearching(true);
    } else if (input === "g") {
      setGrouped((g) => !g);
      setSelected(0);
    } else if (input === "p") setPreviewVisible((v) => !v);
    else if (input === "a") {
      setIncludeSubagents((v) => !v);
      setSelected(0);
    } else if (input === "t") retitle();
    else if (input === "f") doResume(true, false);
    else if (input === "o") doResume(false, true);
    else if (key.return) activate();
  });

  // ---- Layout (recomputed on every resize via useTerminalSize) ----
  const chrome = 2 + (searching ? 1 : 0) + (status ? 1 : 0);
  const body = Math.max(3, termRows - chrome);

  const showPreviewPane = previewVisible && !showHelp && selectedRow !== null;
  const sideBySide = cols >= 100 && showPreviewPane;
  const previewWidth = sideBySide ? Math.min(58, Math.max(40, Math.floor(cols * 0.42))) : 0;
  const listWidth = sideBySide ? Math.max(20, cols - previewWidth - 4) : cols - 2;
  const previewHeightStacked = Math.min(Math.max(8, Math.floor(body * 0.4)), 16);
  const listHeight = sideBySide
    ? body
    : showPreviewPane
      ? Math.max(3, body - previewHeightStacked)
      : body;
  const previewHeight = sideBySide ? body : previewHeightStacked;
  const spin = SPINNER[frame % SPINNER.length];

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
      height={previewHeight}
    />
  ) : null;

  return (
    <Box flexDirection="column" width={cols} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          ccs <Text color={theme.muted}>· {rows.length} shown</Text>
        </Text>
        <Text color={theme.muted}>
          {includeSubagents ? "subagents shown" : `${countSubagentRuns(subCounts)} subagent runs hidden`}
          {titling ? `  ${spin} titling ${titling.done}/${titling.total}` : ""}
        </Text>
      </Box>

      {searching ? (
        <Box>
          <Text color="yellow">/ </Text>
          <Text>{query}</Text>
          <Text color={theme.accent}>▏</Text>
        </Box>
      ) : null}

      {showHelp ? (
        <Help />
      ) : items.length === 0 ? (
        <Box height={body} alignItems="center" justifyContent="center">
          <Text color={theme.muted}>
            {query ? "No sessions match — esc to clear search" : "No sessions indexed yet."}
          </Text>
        </Box>
      ) : sideBySide ? (
        <Box flexDirection="row" height={body}>
          <Box width={listWidth} flexShrink={0} marginRight={1}>
            <SessionList items={items} selected={clampedSelected} height={listHeight} />
          </Box>
          <Box width={previewWidth} flexShrink={0}>
            {previewEl}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box height={listHeight} flexDirection="column">
            <SessionList items={items} selected={clampedSelected} height={listHeight} />
          </Box>
          {showPreviewPane ? previewEl : null}
        </Box>
      )}

      {status ? (
        <Text color="magenta" wrap="truncate-end">
          {status}
        </Text>
      ) : null}

      <Text color={theme.muted} wrap="truncate-end">
        ↵ resume · →← agents · / search · g {grouped ? "flat" : "group"} · p preview · a{" "}
        {includeSubagents ? "hide" : "show"} subs · ? help · q quit
      </Text>
    </Box>
  );
}

function countSubagentRuns(counts: Map<string, number>): number {
  let total = 0;
  for (const n of counts.values()) total += n;
  return total;
}
