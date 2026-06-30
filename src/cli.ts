import pkg from "../package.json" with { type: "json" };
import { loadConfig, type Config } from "./config.ts";
import { scanStore, formatBytes, formatAge } from "./store.ts";
import { existsSync } from "node:fs";
import { ensureDataDir, DB_PATH, CATALOGUE_PATH } from "./paths.ts";
import { openIndex } from "./index/schema.ts";
import type { Database } from "bun:sqlite";
import { reindexStore, listByRecency, titleOf } from "./index/index.ts";
import { openCatalogue, getAll, lifecycleOf, parentEdges } from "./catalogue/db.ts";
import { openSessionIds } from "./catalogue/open-state.ts";
import { describe as describeDisposition } from "./catalogue/disposition.ts";
import { whoami, rename, mark, tag, event, parent, skill, meta } from "./catalogue/commands.ts";
import { backfillTitles } from "./titler/queue.ts";
import { createCodexTitler } from "./titler/codex.ts";
import { handoffInline } from "./resume/inline.ts";
import type { ResumeCommand } from "./resume/command.ts";

const HELP = `ccs — find and resume any Claude Code session

Usage:
  ccs                 Launch the session browser (TUI)
  ccs reindex         Refresh the session index from the store
  ccs reindex --titles   Also (re)generate titles, headless (cron-friendly)
  ccs ls              Print indexed sessions (with catalogue badges)
  ccs ls --event <slug>   Only sessions assigned to that event
  ccs tree            Constellation view: children grouped under their parent
  ccs whoami          Print the current session id (CLAUDE_CODE_SESSION_ID)
  ccs meta [<id>|.]   Show a session's catalogue metadata (. = current session)
  ccs rename [<id>|.] "<name>"   Set a custom title (+ sync cmux workspace name)
  ccs mark [<id>|.] --loop|--completed|--archived [--off]   Set lifecycle/kind flags
  ccs tag [<id>|.] "<Entity>" [--remove]   Add/remove an entity tag
  ccs event [<id>|.] <slug> [--off]   Assign/clear the session's event slug
  ccs parent [<id>|.] <parent-id|.> [--off]   Set/clear the spawning parent session
  ccs skill [<id>|.] <name> [--off]   Set/clear the backing skill or slash-command
  ccs --version       Print version
  ccs --help          Show this help
`;

/** Entry point. Routes argv to a command; returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(pkg.version);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(HELP);
    return 0;
  }

  const command = args[0];
  switch (command) {
    case "reindex":
      return await reindex({ titles: args.includes("--titles") });
    case "ls":
      return ls({
        all: args.includes("--all"),
        loops: args.includes("--loops"),
        event: flagValue(args, "--event"),
      });
    case "tree":
      return tree({ all: args.includes("--all") });
    case "whoami":
      return whoami();
    case "meta":
      return meta(args[1]);
    case "rename":
      return rename(args[1], args.slice(2).filter((a) => !a.startsWith("--")).join(" "));
    case "mark":
      return mark(args[1], args.slice(2).filter((a) => a.startsWith("--")));
    case "tag":
      return tag(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "event":
      return event(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "parent":
      return parent(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "skill":
      return skill(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case undefined:
      return await launchTui();
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 1;
  }
}

/** Load config or print the error and signal failure. */
function getConfig(): Config | null {
  const result = loadConfig();
  if (!result.ok) {
    console.error(result.error.message);
    return null;
  }
  return result.value;
}

/** Refresh the Index from the Store and report what changed. */
async function reindex(opts: { titles: boolean }): Promise<number> {
  ensureDataDir();
  const config = getConfig();
  if (!config) return 1;

  const scan = scanStore(config.store.path);
  if (!scan.ok) {
    console.error(scan.error.message);
    return 1;
  }

  const db = openIndex(DB_PATH);
  try {
    const totalBytes = scan.value.reduce((sum, f) => sum + f.sizeBytes, 0);
    const stats = await reindexStore(db, scan.value, config.host.label);
    console.log(
      `Indexed ${stats.scanned} session${stats.scanned === 1 ? "" : "s"} ` +
        `(${formatBytes(totalBytes)}) from ${config.store.path} [host: ${config.host.label}]`,
    );
    console.log(`  ${stats.parsed} parsed, ${stats.skipped} unchanged, ${stats.removed} removed`);

    if (opts.titles) {
      const titler = createCodexTitler({
        binary: config.titler.binary,
        model: config.titler.model,
        reasoningEffort: config.titler.reasoningEffort,
      });
      process.stdout.write("Generating titles… ");
      const title = await backfillTitles(db, titler, {
        concurrency: config.titler.concurrency,
        maxAttempts: config.titler.maxAttempts,
        onProgress: (done, total) => {
          process.stdout.write(`\rGenerating titles… ${done}/${total}   `);
        },
      });
      process.stdout.write("\n");
      if (title.skippedUnavailable) {
        console.log(`  titling skipped — \`${config.titler.binary}\` not found on PATH`);
      } else {
        console.log(`  ${title.generated} generated, ${title.failed} failed`);
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

/** Launch the interactive browser: refresh the Index, then render the Ink app. */
async function launchTui(): Promise<number> {
  const config = getConfig();
  if (!config) return 1;
  ensureDataDir();

  const firstRun = !existsSync(DB_PATH);
  if (firstRun) console.log("First run — indexing your sessions…");

  const db = openIndex(DB_PATH);
  const catalogue = openCatalogue(CATALOGUE_PATH);
  const resumeRequest: { current: ResumeCommand | null } = { current: null };
  try {
    const scan = scanStore(config.store.path);
    if (scan.ok) await reindexStore(db, scan.value, config.host.label);

    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { App } = await import("./tui/App.tsx");
    const titler = createCodexTitler({
      binary: config.titler.binary,
      model: config.titler.model,
      reasoningEffort: config.titler.reasoningEffort,
    });
    const app = render(createElement(App, { db, catalogue, config, titler, resumeRequest }));
    await app.waitUntilExit();
  } finally {
    db.close();
    catalogue.close();
  }

  // The TUI has fully unmounted (terminal restored) — now hand off to claude inline.
  if (resumeRequest.current) {
    return handoffInline(resumeRequest.current);
  }
  return 0;
}

/** Table of indexed sessions, joined with catalogue metadata + live open-state. */
function ls(opts: { all: boolean; loops: boolean; event?: string }): number {
  const db = openIndex(DB_PATH);
  const cat = openCatalogue(CATALOGUE_PATH);
  try {
    const rows = listByRecency(db);
    if (rows.length === 0) {
      console.log("No sessions indexed. Run `ccs reindex` first.");
      return 0;
    }
    const catalogue = getAll(cat);
    const open = openSessionIds();
    const srcMark = { native: "★", codex: "✎", fallback: " " } as const;
    let shown = 0;
    for (const r of rows) {
      const c = catalogue.get(r.sessionId) ?? null;
      const lifecycle = lifecycleOf(c);
      if (opts.event && c?.event !== opts.event) continue;
      if (!opts.all && lifecycle === "archived") continue;
      if (opts.loops && c?.kind !== "loop") continue;
      const d = describeDisposition(lifecycle, open.has(r.sessionId));
      // A child in the constellation gets a ↳ marker inside the (padded) title cell, keeping columns aligned.
      const childMark = c?.parentSessionId ? "↳ " : "";
      const title = pad(childMark + (c?.customTitle ?? r.title), 42);
      const badge = pad((c?.kind === "loop" ? "LOOP " : "") + d.label + (d.nudge ? "!" : ""), 16);
      const sk = pad(c?.skill ? `⚙${c.skill}` : "", 14);
      // Only print the event column when not already filtering to a single event.
      const evt = opts.event ? "" : pad(c?.event ? `⊞${c.event}` : "", 18);
      const project = pad(r.projectName, 16);
      const age = pad(formatAge(r.lastTs), 5);
      console.log(`${srcMark[r.titleSource]} ${title} ${badge} ${sk}${evt}${project} ${age} ${r.msgCount}m`);
      shown++;
    }
    const hidden = rows.length - shown;
    console.log(
      `\n${shown} sessions  (★ native ✎ codex · LOOP=loop · ⚙=skill · ↳=child · ⊞=event · !=open+parked/completed)` +
        (opts.event ? ` · event=${opts.event}` : "") +
        (hidden > 0 && !opts.all && !opts.event ? ` · ${hidden} hidden (archived/filtered; --all to show)` : ""),
    );
  } finally {
    db.close();
    cat.close();
  }
  return 0;
}

/**
 * Constellation view: the parent→child edges from the catalogue, with children nested under their
 * parent. A "root" is any parent that isn't itself someone's child; on a pure cycle we fall back to
 * every parent as a root, and a seen-set guards the recursion so a cycle prints once, not forever.
 */
function tree(_opts: { all: boolean }): number {
  const db = openIndex(DB_PATH);
  const cat = openCatalogue(CATALOGUE_PATH);
  try {
    const edges = parentEdges(cat);
    if (edges.length === 0) {
      console.log("No constellation edges yet. Link one with `ccs parent <id|.> <parent-id|.>`.");
      return 0;
    }
    const childMap = new Map<string, string[]>();
    const isChild = new Set<string>();
    for (const e of edges) {
      const kids = childMap.get(e.parentId) ?? [];
      kids.push(e.sessionId);
      childMap.set(e.parentId, kids);
      isChild.add(e.sessionId);
    }
    for (const kids of childMap.values()) kids.sort();
    const catMap = getAll(cat);
    const skillOf = (id: string): string => {
      const s = catMap.get(id)?.skill;
      return s ? `  ⚙${s}` : "";
    };
    let roots = [...childMap.keys()].filter((p) => !isChild.has(p)).sort();
    if (roots.length === 0) roots = [...childMap.keys()].sort();
    const seen = new Set<string>();
    const print = (id: string, depth: number): void => {
      const indent = depth === 0 ? "" : "  ".repeat(depth - 1) + "↳ ";
      if (seen.has(id)) {
        console.log(`${indent}${labelForId(db, id)}  ↻ (cycle)`);
        return;
      }
      seen.add(id);
      console.log(`${indent}${labelForId(db, id)}${skillOf(id)}`);
      for (const kid of childMap.get(id) ?? []) print(kid, depth + 1);
    };
    for (const r of roots) print(r, 0);
  } finally {
    db.close();
    cat.close();
  }
  return 0;
}

/** Short, skimmable label for a session id: `1a2b3c4d… <title>`, degrading to the bare id when unindexed. */
function labelForId(db: Database, id: string): string {
  const short = `${id.slice(0, 8)}…`;
  const title = titleOf(db, id);
  return title ? `${short} ${title}` : short;
}

/** Read the value after a `--flag` in argv, or undefined if absent/last. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

/** Pad/truncate a string to an exact display width. */
function pad(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width - 1) + "…" : text;
  return t.padEnd(width);
}
