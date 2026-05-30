import pkg from "../package.json" with { type: "json" };
import { loadConfig, type Config } from "./config.ts";
import { scanStore, formatBytes, formatAge } from "./store.ts";
import { existsSync } from "node:fs";
import { ensureDataDir, DB_PATH } from "./paths.ts";
import { openIndex } from "./index/schema.ts";
import { reindexStore, listByRecency } from "./index/index.ts";
import { backfillTitles } from "./titler/queue.ts";
import { createCodexTitler } from "./titler/codex.ts";
import { handoffInline } from "./resume/inline.ts";
import type { ResumeCommand } from "./resume/command.ts";

const HELP = `ccs — find and resume any Claude Code session

Usage:
  ccs                 Launch the session browser (TUI)
  ccs reindex         Refresh the session index from the store
  ccs reindex --titles   Also (re)generate titles, headless (cron-friendly)
  ccs ls              Print indexed sessions (debug)
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
      return ls();
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
    const app = render(createElement(App, { db, config, titler, resumeRequest }));
    await app.waitUntilExit();
  } finally {
    db.close();
  }

  // The TUI has fully unmounted (terminal restored) — now hand off to claude inline.
  if (resumeRequest.current) {
    return handoffInline(resumeRequest.current);
  }
  return 0;
}

/** Debug table of indexed sessions (the TUI replaces this in Milestone 4). */
function ls(): number {
  const db = openIndex(DB_PATH);
  try {
    const rows = listByRecency(db);
    if (rows.length === 0) {
      console.log("No sessions indexed. Run `ccs reindex` first.");
      return 0;
    }
    const mark = { native: "★", codex: "✎", fallback: " " } as const;
    for (const r of rows) {
      const title = pad(r.title, 46);
      const project = pad(r.projectName, 18);
      const branch = pad(r.branch ?? "-", 12);
      const age = pad(formatAge(r.lastTs), 5);
      console.log(`${mark[r.titleSource]} ${title} ${project} ${branch} ${age} ${r.msgCount}m`);
    }
    console.log(`\n${rows.length} sessions  (★ native title, ✎ codex)`);
  } finally {
    db.close();
  }
  return 0;
}

/** Pad/truncate a string to an exact display width. */
function pad(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width - 1) + "…" : text;
  return t.padEnd(width);
}
