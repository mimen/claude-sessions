import pkg from "../package.json" with { type: "json" };
import { loadConfig, type Config } from "./config.ts";
import { scanStore, formatBytes, formatAge } from "./store.ts";
import { existsSync } from "node:fs";
import { ensureDataDir, DB_PATH, CATALOGUE_PATH } from "./paths.ts";
import { openIndex } from "./index/schema.ts";
import type { Database } from "bun:sqlite";
import { reindexStore, listByRecency, titleOf, costOf, subagentCosts } from "./index/index.ts";
import { formatCost } from "./cost.ts";
import { openCatalogue, getAll, lifecycleOf, parentEdges } from "./catalogue/db.ts";
import { openSessionIds } from "./catalogue/open-state.ts";
import { describe as describeDisposition } from "./catalogue/disposition.ts";
import { whoami, rename, mark, tag, event, parent, skill, role, substrate, identity, meta, SESSION_ID_RE } from "./catalogue/commands.ts";
import { lineage } from "./catalogue/lineage.ts";
import { merge, mergePull, lsFleet, intent, applyIntentsCommand } from "./catalogue/fleet-commands.ts";
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
  ccs ls --role <name>    Only bodies of that role
  ccs ls --fleet [--host <h>] [--all]   Fleet-wide sessions from the merged view (every host)
  ccs tree            Constellation view: children grouped under their parent
  ccs lineage <role> [--search "<q>"]   A role's bodies in succession order (+ transcript search)
  ccs merge           Build the merged fleet view from local + replica data (merge host only)
  ccs merge --pull    Fetch the merge host's merged view here (other hosts)
  ccs intent <id> <op> [<value>] [--off]   Send a catalogue edit for a foreign row (fleet envelope)
  ccs apply-intents [<state-dir>]   Apply this host's edit intents from the applier role's inbox
                                    (or from stdin JSON lines when no state dir is given)
  ccs whoami          Print the current session id (CLAUDE_CODE_SESSION_ID)
  ccs meta [<id>|.]   Show a session's catalogue metadata (. = current session)
  ccs rename [<id>|.] "<name>"   Set a custom title (+ sync cmux workspace name)
  ccs mark [<id>|.] --loop|--completed|--archived [--off]   Set lifecycle/kind flags
  ccs tag [<id>|.] "<Entity>" [--remove]   Add/remove an entity tag
  ccs event [<id>|.] <slug> [--off]   Assign/clear the session's event slug
  ccs parent [<id>|.] <parent-id|.> [--off]   Set/clear the spawning parent session
  ccs skill [<id>|.] <name> [--off]   Set/clear the backing skill or slash-command
  ccs role [<id>|.] <name> [--off]    Set/clear the fleet role this session is a body of
  ccs substrate [<id>|.] <value> [--off]   Set/clear the agent runtime (unset = claude-code)
  ccs identity [<id>|.] [<name>] [--off]   Record the launching identity (default: $CLAUDE_IDENTITY)
  ccs skills          Machine-wide skill registry with usage data (ccs skills --help)
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
      if (args.includes("--fleet")) {
        return lsFleet({
          host: flagValue(args, "--host"),
          role: flagValue(args, "--role"),
          all: args.includes("--all"),
        });
      }
      return ls({
        all: args.includes("--all"),
        loops: args.includes("--loops"),
        event: flagValue(args, "--event"),
        role: flagValue(args, "--role"),
      });
    case "merge":
      return args.includes("--pull") ? mergePull() : merge();
    case "intent":
      return intent(args.slice(1));
    case "apply-intents":
      return await applyIntentsCommand(args.slice(1).find((a) => !a.startsWith("--")));
    case "tree":
      return tree({ all: args.includes("--all") });
    case "lineage": {
      // `--search` owns its next token, so the role is the first token no flag consumed.
      const rest = args.slice(1);
      let roleArg: string | undefined;
      let search: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]!;
        if (t === "--search") {
          search = rest[++i];
        } else if (!t.startsWith("--") && roleArg === undefined) {
          roleArg = t;
        }
      }
      if (args.includes("--search") && !search?.trim()) {
        console.error('usage: ccs lineage <role> --search "<query>"');
        return 1;
      }
      return await lineage(roleArg, search?.trim());
    }
    case "whoami":
      return whoami();
    case "meta":
      return meta(args[1]);
    case "rename":
      return rename(args[1], args.slice(2).filter((a) => !a.startsWith("--")).join(" "));
    case "mark":
      return mark(args[1], args.slice(2).filter((a) => a.startsWith("--")));
    case "tag":
      return tag(...edgeArgs(args));
    case "event":
      return event(...edgeArgs(args));
    case "parent":
      return parent(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "skill":
      return skill(...edgeArgs(args));
    case "role":
      return role(...edgeArgs(args));
    case "substrate":
      return substrate(...edgeArgs(args));
    case "identity":
      return identity(...edgeArgs(args));
    case "skills": {
      // Bare `ccs skills` on a terminal opens the TUI in skills mode; flags/subcommands
      // (or piped output) use the plain-table command path.
      if (args.length === 1 && process.stdout.isTTY) return await launchTui("skills");
      const { skillsCommand } = await import("./skills/command.ts");
      return await skillsCommand(args.slice(1));
    }
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
    const spend = db.query("SELECT SUM(cost_usd) AS usd FROM sessions").get() as { usd: number | null };
    if (spend.usd) console.log(`  ${formatCost(spend.usd)} total API-equivalent spend across the store`);

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
async function launchTui(initialMode: "sessions" | "skills" = "sessions"): Promise<number> {
  const config = getConfig();
  if (!config) return 1;
  ensureDataDir();

  const firstRun = !existsSync(DB_PATH);
  if (firstRun) console.log("First run — indexing your sessions…");

  const db = openIndex(DB_PATH);
  const catalogue = openCatalogue(CATALOGUE_PATH);
  const { openSkillsDb } = await import("./skills/db.ts");
  const { SKILLS_DB_PATH } = await import("./paths.ts");
  const skillsDb = openSkillsDb(SKILLS_DB_PATH);
  const resumeRequest: { current: ResumeCommand | null } = { current: null };
  try {
    const scan = scanStore(config.store.path);
    if (scan.ok) await reindexStore(db, scan.value, config.host.label);
    // A failed scan must not masquerade as "no sessions". Ink's first fullscreen frame wipes
    // anything printed here, so the warning rides INTO the TUI as its opening status line
    // (and is re-printed after exit for scrollback).
    const scanWarning = scan.ok
      ? null
      : `store scan failed — showing the last-indexed state. ${scan.error.message}`;

    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { Root } = await import("./tui/Root.tsx");
    const titler = createCodexTitler({
      binary: config.titler.binary,
      model: config.titler.model,
      reasoningEffort: config.titler.reasoningEffort,
    });
    const app = render(
      createElement(Root, { db, catalogue, skillsDb, config, titler, resumeRequest, initialMode, initialStatus: scanWarning }),
    );
    await app.waitUntilExit();
    if (scanWarning) console.error(`ccs: ${scanWarning}`);
  } finally {
    db.close();
    catalogue.close();
    skillsDb.close();
  }

  // The TUI has fully unmounted (terminal restored) — now hand off to claude inline.
  if (resumeRequest.current) {
    // The cwd-resolution warning (ambiguity/drift) must outlive the TUI: print it here,
    // right above claude's own output, where it can actually be read.
    if (resumeRequest.current.note) console.error(`ccs: ${resumeRequest.current.note}`);
    return handoffInline(resumeRequest.current);
  }
  return 0;
}

/** Table of indexed sessions, joined with catalogue metadata + live open-state. */
function ls(opts: { all: boolean; loops: boolean; event?: string; role?: string }): number {
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
    // Subagent runs are separate index rows keyed to the parent's INTERNAL id (= resumeId).
    const subCosts = subagentCosts(db);
    const srcMark = { native: "★", codex: "✎", fallback: " " } as const;
    let shown = 0;
    for (const r of rows) {
      const c = catalogue.get(r.sessionId) ?? null;
      const lifecycle = lifecycleOf(c);
      if (opts.event && c?.event !== opts.event) continue;
      if (opts.role && c?.role !== opts.role) continue;
      if (!opts.all && lifecycle === "archived") continue;
      if (opts.loops && c?.kind !== "loop") continue;
      const d = describeDisposition(lifecycle, open.has(r.sessionId));
      // A child in the constellation gets a ↳ marker inside the (padded) title cell, keeping columns aligned.
      const childMark = c?.parentSessionId ? "↳ " : "";
      const title = pad(childMark + (c?.customTitle ?? r.title), 42);
      const badge = pad((c?.kind === "loop" ? "LOOP " : "") + d.label + (d.nudge ? "!" : ""), 16);
      const sk = pad(c?.skill ? `⚙${c.skill}` : "", 14);
      // Filtered-on columns are redundant — only print role/event when not filtering to one.
      const rl = opts.role ? "" : pad(c?.role ? `◈${c.role}` : "", 14);
      const evt = opts.event ? "" : pad(c?.event ? `⊞${c.event}` : "", 18);
      const project = pad(r.projectName, 16);
      const age = pad(formatAge(r.lastTs), 5);
      const subCost = subCosts.get(r.sessionId) ?? subCosts.get(r.resumeId) ?? 0;
      const cost = pad(formatCost(r.costUSD + subCost), 7);
      console.log(`${srcMark[r.titleSource]} ${title} ${badge} ${sk}${rl}${evt}${project} ${age} ${cost} ${r.msgCount}m`);
      shown++;
    }
    const hidden = rows.length - shown;
    console.log(
      `\n${shown} sessions  (★ native ✎ codex · LOOP=loop · ⚙=skill · ◈=role · ↳=child · ⊞=event · !=open+parked/completed · $=API-equivalent cost incl. subagents)` +
        (opts.event ? ` · event=${opts.event}` : "") +
        (opts.role ? ` · role=${opts.role}` : "") +
        (hidden > 0 && !opts.all && !opts.event && !opts.role ? ` · ${hidden} hidden (archived/filtered; --all to show)` : ""),
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
    // A node's own cost includes its index-level subagent runs (agent-*.jsonl files).
    const subCosts = subagentCosts(db);
    const ownCost = (id: string): number => costOf(db, id) + (subCosts.get(id) ?? 0);
    const subtreeCost = (id: string, visiting = new Set<string>()): number => {
      if (visiting.has(id)) return 0; // cycle guard
      visiting.add(id);
      let sum = ownCost(id);
      for (const kid of childMap.get(id) ?? []) sum += subtreeCost(kid, visiting);
      return sum;
    };
    const costLabel = (id: string): string => {
      const own = ownCost(id);
      const kids = childMap.get(id) ?? [];
      const total = kids.length ? subtreeCost(id) : own;
      const ownStr = formatCost(own);
      const parts: string[] = [];
      if (ownStr) parts.push(ownStr);
      if (kids.length && total > own) parts.push(`Σ${formatCost(total)}`);
      return parts.length ? `  ${parts.join(" ")}` : "";
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
      console.log(`${indent}${labelForId(db, id)}${skillOf(id)}${costLabel(id)}`);
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

/**
 * Args for the `<verb> [<id>|.] [<value>] [--flags]` verbs. An explicit session id must LOOK
 * like one (a UUID, "." or "self"); any other first positional is the VALUE with the session
 * defaulting to the current one — so `ccs role <name>` and `ccs identity --off` do what they
 * say instead of upserting a catalogue row keyed by the name or the flag.
 */
function edgeArgs(args: string[]): [string | undefined, string | undefined, string[]] {
  const rest = args.slice(1);
  const flags = rest.filter((a) => a.startsWith("--"));
  const pos = rest.filter((a) => !a.startsWith("--"));
  const explicit = pos[0] === "." || pos[0] === "self" || (pos[0] !== undefined && SESSION_ID_RE.test(pos[0]));
  return explicit ? [pos[0], pos[1], flags] : [undefined, pos[0], flags];
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
