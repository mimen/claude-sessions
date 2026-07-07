import React, { useState, useMemo, useEffect } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { Database } from "bun:sqlite";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { Config } from "../../config.ts";
import { useTerminalSize } from "../useTerminalSize.ts";
import { theme } from "../theme.ts";
import {
  loadSkills,
  saveSkills,
  usageTotals,
  tagsFor,
  categoriesFor,
  setCategory,
  addTag,
  removeTag,
  usageFilesFor,
  removeSkillPath,
} from "../../skills/db.ts";
import { discoverSkills, isInLinkedWorktree, type SkillRecord } from "../../skills/scan.ts";
import { mineUsage } from "../../skills/usage.ts";
import { archiveSkill, archiveGuard } from "../../skills/archive.ts";
import {
  buildSkillItems,
  driftedNames,
  homeOf,
  matchesQuery,
  shadowDuplicatePaths,
  SKILLS_SORT_CYCLE,
  SKILLS_VIEW_CYCLE,
  type SkillItem,
  type SkillRow,
  type SkillsSort,
  type SkillsView,
} from "../../skills/view.ts";
import { SkillsList } from "./SkillsList.tsx";
import { SkillsPreview, type FileEntry, type UsedByEntry } from "./SkillsPreview.tsx";
import { SkillReader, type ReaderState } from "./SkillReader.tsx";

interface SkillsPanelProps {
  skillsDb: Database;
  /** Session Index — used to resolve transcript files → project names for used-by. */
  indexDb: Database;
  config: Config;
  onSwitchMode: () => void;
  /** Cross-jump: flip to session view pinned to the sessions that used this skill. */
  onShowSessions: (sessionPaths: string[], label: string) => void;
}

type InputMode =
  | { kind: "search" }
  | { kind: "tag"; buffer: string }
  | { kind: "category"; buffer: string }
  | { kind: "confirm-archive"; rec: SkillRecord };

/** List files in a skill dir (2 levels), SKILL.md first. */
function listSkillFiles(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (d: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 2) walk(full, rel, depth + 1);
      } else {
        try {
          out.push({ rel, sizeBytes: statSync(full).size });
        } catch {
          // racing delete
        }
      }
    }
  };
  walk(dir, "", 0);
  out.sort((a, b) => (a.rel === "SKILL.md" ? -1 : b.rel === "SKILL.md" ? 1 : a.rel.localeCompare(b.rel)));
  return out;
}

function openWith(cmd: string[], onFail: () => void): void {
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  } catch {
    onFail();
  }
}

/** Editor resolution: $VISUAL/$EDITOR if GUI-safe, else cursor, else macOS open. */
function editorCommand(target: string): string[] {
  const ed = process.env["VISUAL"] ?? process.env["EDITOR"];
  if (ed && !/vi|vim|nano|emacs -nw/.test(ed)) return [...ed.split(" "), target];
  return ["cursor", target];
}

export function SkillsPanel({ skillsDb, indexDb, config, onSwitchMode, onShowSessions }: SkillsPanelProps): React.ReactElement {
  const { exit } = useApp();
  const { columns: cols, rows: termRows } = useTerminalSize();

  const [refreshTick, setRefreshTick] = useState(0);
  const [records, setRecords] = useState<SkillRecord[]>(() => loadSkills(skillsDb));
  const [view, setView] = useState<SkillsView>("home");
  const [sort, setSort] = useState<SkillsSort>("recent");
  const [selected, setSelected] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<InputMode | null>(null);
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [showWorktrees, setShowWorktrees] = useState(false);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reader, setReader] = useState<ReaderState | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const reload = () => setRefreshTick((t) => t + 1);

  // First mount: discover if the registry is empty, then mine incrementally (fast after first run).
  useEffect(() => {
    let alive = true;
    const run = async () => {
      let recs = records;
      if (recs.length === 0) {
        setBusy("scanning the machine for skills…");
        const found = await discoverSkills();
        if (!alive) return;
        if (found.ok) {
          saveSkills(skillsDb, found.value);
          recs = found.value;
          setRecords(recs);
        }
      }
      setBusy("mining transcripts for usage…");
      const dirs = new Map<string, string>();
      for (const s of recs) {
        dirs.set(s.path, s.name);
        dirs.set(s.realPath, s.name);
        for (const a of s.aliases) dirs.set(a, s.name);
      }
      await mineUsage(skillsDb, config.store.path, dirs);
      if (!alive) return;
      setBusy(null);
      reload();
    };
    void run();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usage = useMemo(() => usageTotals(skillsDb), [skillsDb, refreshTick]);
  const tags = useMemo(() => tagsFor(skillsDb), [skillsDb, refreshTick]);
  const categories = useMemo(() => categoriesFor(skillsDb), [skillsDb, refreshTick]);
  const drifted = useMemo(() => driftedNames(records), [records]);

  const allRows = useMemo<SkillRow[]>(
    () =>
      records.map((rec) => ({
        rec,
        home: homeOf(rec.path),
        category: categories.get(rec.name) ?? null,
        tags: tags.get(rec.name) ?? [],
        usage: usage.get(rec.name) ?? null,
        drift: drifted.has(rec.name),
      })),
    [records, categories, tags, usage, drifted],
  );

  // Duplication noise, hidden unless toggled: linked-worktree copies (each checkout duplicates
  // its repo's skills) + exact-content shadow copies (a tool's repo clone AND installed copy).
  const dupePaths = useMemo(() => {
    const cache = new Map<string, boolean>();
    const hidden = shadowDuplicatePaths(records);
    for (const r of records) if (isInLinkedWorktree(r.realPath, cache)) hidden.add(r.path);
    return hidden;
  }, [records]);

  const rows = useMemo(() => {
    let r = allRows;
    if (!showWorktrees) r = r.filter((x) => !dupePaths.has(x.rec.path));
    if (unusedOnly) r = r.filter((x) => !x.usage);
    if (query.trim()) r = r.filter((x) => matchesQuery(x, query));
    return r;
  }, [allRows, unusedOnly, query, showWorktrees, dupePaths]);

  const items = useMemo<SkillItem[]>(
    () => buildSkillItems(rows, { view, sort, collapsed, nowMs: Date.now() }),
    [rows, view, sort, collapsed],
  );

  const clampedSelected = Math.min(selected, Math.max(0, items.length - 1));
  const current = items[clampedSelected];
  const selectedRow: SkillRow | null = current?.kind === "skill" ? current.row : null;

  // Preview data for the selected row (cheap fs/db lookups, keyed by path).
  const siblings = useMemo(() => {
    if (!selectedRow) return [];
    return records
      .filter((r) => r.name === selectedRow.rec.name && r.path !== selectedRow.rec.path)
      .map((r) => ({ path: r.path, differs: !!r.contentHash && !!selectedRow.rec.contentHash && r.contentHash !== selectedRow.rec.contentHash }));
  }, [records, selectedRow?.rec.path]);

  const files = useMemo(() => (selectedRow ? listSkillFiles(selectedRow.rec.realPath) : []), [selectedRow?.rec.realPath, refreshTick]);

  const projectByPath = useMemo(() => {
    const rows2 = indexDb.query("SELECT path, project_name AS projectName FROM sessions").all() as Array<{
      path: string;
      projectName: string;
    }>;
    return new Map(rows2.map((r) => [r.path, r.projectName]));
  }, [indexDb, refreshTick]);

  const usedBy = useMemo<UsedByEntry[]>(() => {
    if (!selectedRow?.usage) return [];
    const byProject = new Map<string, number>();
    for (const f of usageFilesFor(skillsDb, selectedRow.rec.name)) {
      const project = projectByPath.get(f.file) ?? basename(f.file).slice(0, 8);
      byProject.set(project, (byProject.get(project) ?? 0) + f.count);
    }
    return [...byProject.entries()]
      .map(([project, count]) => ({ project, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 4);
  }, [skillsDb, selectedRow?.rec.name, selectedRow?.usage, projectByPath]);

  const move = (delta: number) => setSelected((s) => Math.max(0, Math.min(s + delta, items.length - 1)));

  const toggleSection = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const openReader = () => {
    if (!selectedRow) return;
    const fileList = files.map((f) => f.rel);
    if (fileList.length === 0) return;
    const first = fileList.indexOf("SKILL.md");
    loadReaderFile(selectedRow.rec.realPath, selectedRow.rec.name, fileList, first === -1 ? 0 : first);
  };

  const loadReaderFile = (dir: string, skillName: string, fileList: string[], index: number) => {
    let text = "";
    try {
      text = readFileSync(join(dir, fileList[index]!), "utf8");
    } catch (e) {
      text = `(failed to read: ${(e as Error).message})`;
    }
    setReader({ skillName, files: fileList, fileIndex: index, lines: text.split("\n"), scroll: 0 });
  };

  const doRescan = () => {
    setBusy("rescanning the machine…");
    void discoverSkills().then((found) => {
      if (found.ok) {
        saveSkills(skillsDb, found.value);
        setRecords(found.value);
        setStatus(`rescan: ${found.value.length} skills`);
      } else {
        setStatus(found.error.message);
      }
      setBusy(null);
      reload();
    });
  };

  const doArchive = (rec: SkillRecord) => {
    const res = archiveSkill(rec, new Date().toISOString());
    if (res.ok) {
      removeSkillPath(skillsDb, rec.path);
      setRecords((rs) => rs.filter((r) => r.path !== rec.path));
      setStatus(`archived → ${res.value}`);
    } else {
      setStatus(res.error.message);
    }
    setMode(null);
  };

  const crossJump = () => {
    if (!selectedRow) return;
    const filesUsed = usageFilesFor(skillsDb, selectedRow.rec.name).map((f) => f.file);
    if (filesUsed.length === 0) {
      setStatus("no sessions observed using this skill");
      return;
    }
    onShowSessions(filesUsed, selectedRow.rec.name);
  };

  useInput((input, key) => {
    // Reader owns input while open.
    if (reader) {
      const page = Math.max(1, termRows - 6);
      const clampScroll = (r: ReaderState, delta: number) => ({
        ...r,
        scroll: Math.max(0, Math.min(r.scroll + delta, Math.max(0, r.lines.length - 3))),
      });
      if (key.escape || input === "q" || input === "v") setReader(null);
      else if (key.upArrow || input === "k") setReader((r) => (r ? clampScroll(r, -1) : r));
      else if (key.downArrow || input === "j") setReader((r) => (r ? clampScroll(r, 1) : r));
      else if (key.pageUp) setReader((r) => (r ? clampScroll(r, -page) : r));
      else if (key.pageDown || input === " ") setReader((r) => (r ? clampScroll(r, page) : r));
      else if (input === "g") setReader((r) => (r ? { ...r, scroll: 0 } : r));
      else if (input === "G") setReader((r) => (r ? { ...r, scroll: Math.max(0, r.lines.length - 3) } : r));
      else if (key.tab || key.rightArrow) {
        if (selectedRow && reader.files.length > 1)
          loadReaderFile(selectedRow.rec.realPath, reader.skillName, reader.files, (reader.fileIndex + 1) % reader.files.length);
      } else if (key.leftArrow) {
        if (selectedRow && reader.files.length > 1)
          loadReaderFile(
            selectedRow.rec.realPath,
            reader.skillName,
            reader.files,
            (reader.fileIndex - 1 + reader.files.length) % reader.files.length,
          );
      }
      return;
    }

    if (mode?.kind === "search") {
      if (key.escape) {
        setMode(null);
        setQuery("");
      } else if (key.return) setMode(null);
      else if (key.backspace || key.delete) setQuery((q) => q.slice(0, -1));
      else if (key.upArrow) move(-1);
      else if (key.downArrow) move(1);
      else if (input && !key.ctrl && !key.meta) setQuery((q) => q + input);
      return;
    }

    if (mode?.kind === "tag" || mode?.kind === "category") {
      if (key.escape) setMode(null);
      else if (key.return) {
        const value = mode.buffer.trim();
        if (selectedRow) {
          if (mode.kind === "category") {
            setCategory(skillsDb, selectedRow.rec.name, value || null);
            setStatus(value ? `category(${selectedRow.rec.name}) = ${value}` : `category cleared`);
          } else if (value) {
            const existing = tags.get(selectedRow.rec.name) ?? [];
            if (existing.includes(value)) {
              removeTag(skillsDb, selectedRow.rec.name, value);
              setStatus(`untagged ${value}`);
            } else {
              addTag(skillsDb, selectedRow.rec.name, value);
              setStatus(`tagged ${value}`);
            }
          }
        }
        setMode(null);
        reload();
      } else if (key.backspace || key.delete) setMode({ ...mode, buffer: mode.buffer.slice(0, -1) });
      else if (input && !key.ctrl && !key.meta) setMode({ ...mode, buffer: mode.buffer + input });
      return;
    }

    if (mode?.kind === "confirm-archive") {
      if (input === "y" || input === "Y") doArchive(mode.rec);
      else {
        setMode(null);
        setStatus("archive cancelled");
      }
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

    if (key.escape) {
      if (query) {
        setQuery("");
        setSelected(0);
      } else exit();
      return;
    }
    if (input === "q") exit();
    else if (key.tab) onSwitchMode();
    else if (key.upArrow || input === "k") move(-1);
    else if (key.downArrow || input === "j") move(1);
    else if (input === "/") setMode({ kind: "search" });
    else if (input === "g") {
      setView((v) => SKILLS_VIEW_CYCLE[(SKILLS_VIEW_CYCLE.indexOf(v) + 1) % SKILLS_VIEW_CYCLE.length]!);
      setSelected(0);
    } else if (input === "S") {
      setSort((s) => SKILLS_SORT_CYCLE[(SKILLS_SORT_CYCLE.indexOf(s) + 1) % SKILLS_SORT_CYCLE.length]!);
    } else if (input === "p") setPreviewVisible((v) => !v);
    else if (input === "u") {
      setUnusedOnly((v) => !v);
      setSelected(0);
    } else if (input === "w") {
      setShowWorktrees((v) => !v);
      setSelected(0);
    } else if (input === "v") openReader();
    else if (key.return) {
      if (current?.kind === "section") toggleSection(current.key);
      else openReader();
    } else if (key.rightArrow || input === "l") {
      if (current?.kind === "section" && current.collapsed) toggleSection(current.key);
    } else if (key.leftArrow || input === "h") {
      if (current?.kind === "section" && !current.collapsed) toggleSection(current.key);
    } else if (input === "o") {
      if (selectedRow) {
        openWith(editorCommand(selectedRow.rec.realPath), () => setStatus("editor launch failed"));
        setStatus(`opened ${selectedRow.rec.name} in editor`);
      }
    } else if (input === "f") {
      if (selectedRow) {
        openWith(["open", selectedRow.rec.realPath], () => setStatus("open failed"));
        setStatus(`revealed ${selectedRow.rec.name} in Finder`);
      }
    } else if (input === "e") {
      if (selectedRow) {
        openWith(editorCommand(join(selectedRow.rec.realPath, "SKILL.md")), () => setStatus("editor launch failed"));
        setStatus(`editing ${selectedRow.rec.name}/SKILL.md`);
      }
    } else if (input === "t") {
      if (selectedRow) setMode({ kind: "tag", buffer: "" });
    } else if (input === "c") {
      if (selectedRow) setMode({ kind: "category", buffer: selectedRow.category ?? "" });
    } else if (input === "y") {
      if (selectedRow) {
        try {
          Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(selectedRow.rec.path) });
          setStatus(`copied ${selectedRow.rec.path}`);
        } catch {
          setStatus("pbcopy failed");
        }
      }
    } else if (input === "R") doRescan();
    else if (input === "X") {
      if (selectedRow) {
        const guard = archiveGuard(selectedRow.rec);
        if (guard) setStatus(guard);
        else setMode({ kind: "confirm-archive", rec: selectedRow.rec });
      }
    } else if (input === "s") crossJump();
  });

  // ---- Layout ----
  const listMode = !reader && !showHelp;
  const searching = mode?.kind === "search";
  const inputBar = mode && mode.kind !== "confirm-archive" ? 1 : 0;
  const confirmBar = mode?.kind === "confirm-archive" ? 1 : 0;
  const chrome = 3 + (listMode ? 1 : 0) + inputBar + confirmBar + (status || busy ? 1 : 0);
  const body = Math.max(3, termRows - chrome);
  const contentWidth = cols - 2;

  const showPreviewPane = previewVisible && listMode && items.length > 0;
  const sideBySide = cols >= 100 && showPreviewPane;
  const previewWidth = sideBySide ? Math.min(58, Math.max(40, Math.floor(cols * 0.42))) : 0;
  const listWidth = sideBySide ? Math.max(20, contentWidth - previewWidth - 1) : contentWidth;
  const previewHeightStacked = Math.min(Math.max(8, Math.floor(body * 0.4)), 18);
  const stackedListRows = sideBySide ? body : showPreviewPane ? Math.max(3, body - previewHeightStacked) : body;
  const listHeight = Math.max(1, stackedListRows - 1);
  const previewHeight = sideBySide ? body : previewHeightStacked;

  const unobserved = rows.filter((r) => !r.usage).length;

  const previewEl =
    selectedRow && showPreviewPane ? (
      <SkillsPreview row={selectedRow} siblings={siblings} usedBy={usedBy} files={files} height={previewHeight} />
    ) : null;

  const listCol = (w: number) => (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.headerLabel}>
          {" "}
          <Text bold color={theme.header}>
            SKILL
          </Text>
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.headerLabel} bold>
          {"HOME".padEnd(15)}
          {"CATEGORY".padEnd(13)}
          {"INV/SLA/RD".padStart(13)}
          {"AGE".padStart(5)}
        </Text>
      </Box>
      <SkillsList items={items} selected={clampedSelected} height={listHeight} width={w} />
    </Box>
  );

  return (
    <Box flexDirection="column" width={cols} paddingX={1}>
      <Box>
        <Text bold color={theme.header}>
          SKILLS
        </Text>
        <Text color={theme.muted}>
          {" "}
          · {rows.length} skills · {unobserved} unobserved · view {view} · sort {sort}
          {unusedOnly ? " · UNUSED ONLY" : ""}
          {!showWorktrees && dupePaths.size > 0 ? ` · ${dupePaths.size} duplicate copies hidden (w)` : ""}
          {showWorktrees ? " · +dupes" : ""}
          {query && !searching ? ` · filter: ${query}` : ""}
        </Text>
        <Box flexGrow={1} />
        <Text color={theme.headerLabel}>Tab sessions · ? help</Text>
      </Box>
      {listMode ? <Text color={theme.headerBorder}>{"─".repeat(Math.max(0, contentWidth))}</Text> : null}

      {searching ? (
        <Box>
          <Text color="yellow">/ </Text>
          <Text>{query}</Text>
          <Text color={theme.accent}>▏</Text>
        </Box>
      ) : null}
      {mode?.kind === "tag" || mode?.kind === "category" ? (
        <Box>
          <Text color={theme.accent} bold>
            {mode.kind === "tag" ? "tag› " : "category› "}
          </Text>
          <Text color={theme.project}>{selectedRow ? `«${selectedRow.rec.name}» ` : ""}</Text>
          <Text>{mode.buffer}</Text>
          <Text color={theme.accent}>▏</Text>
        </Box>
      ) : null}
      {mode?.kind === "confirm-archive" ? (
        <Text color="yellow" bold>
          Archive {mode.rec.path} → vault _archive/skills/ ? (y/N)
        </Text>
      ) : null}

      {reader ? (
        <SkillReader reader={reader} width={contentWidth} height={body} />
      ) : showHelp ? (
        <Box flexDirection="column" height={body} paddingX={2}>
          <Text bold color={theme.header}>
            Skills mode keys
          </Text>
          <Text color={theme.muted}>Tab switch to sessions · g cycle view (home/name/category/activity/flat) · S cycle sort</Text>
          <Text color={theme.muted}>enter/v read skill files (Tab cycles files) · p preview · / search (#term = category/tag)</Text>
          <Text color={theme.muted}>o open dir in editor · f reveal in Finder · e edit SKILL.md · y copy path</Text>
          <Text color={theme.muted}>t tag (toggles) · c set category (empty clears) · u unused-only · R rescan machine</Text>
          <Text color={theme.muted}>w show/hide duplicate copies (hidden by default: git-worktree checkouts + identical repo-clone/install shadow copies)</Text>
          <Text color={theme.muted}>s show sessions that used this skill · X archive copy to vault (y/N confirm)</Text>
          <Text color={theme.muted}>≠ = same-name copies have drifted apart · INV/SLA/RD = invoked / slash / doc-reads</Text>
        </Box>
      ) : items.length === 0 ? (
        <Box height={body} alignItems="center" justifyContent="center">
          <Text color={theme.muted}>{query ? "No skills match — esc to clear" : busy ?? "No skills found — R to rescan"}</Text>
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
          {previewEl}
        </Box>
      )}

      {busy && items.length > 0 ? <Text color={theme.accent}>{busy}</Text> : status && !reader ? (
        <Text color="magenta" wrap="truncate-end">
          {status}
        </Text>
      ) : null}

      {reader ? (
        <Text color={theme.muted} wrap="truncate-end">
          Tab/←→ next file · j/k scroll · g/G top/bottom · q close
        </Text>
      ) : (
        <Text color={theme.muted} wrap="truncate-end">
          ↵ read · Tab sessions · g group-by:{view} · S sort:{sort} · / search · o editor · f finder · e edit · t tag · c
          category · s used-by · u unused · w dupes · y path · X archive · R rescan · ? help · q quit
        </Text>
      )}
    </Box>
  );
}
