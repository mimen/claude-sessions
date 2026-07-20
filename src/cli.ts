import pkg from "../package.json" with { type: "json" };
import { loadConfig, type Config } from "./config.ts";
import { scanStore, formatBytes, formatAge } from "./store.ts";
import { existsSync } from "node:fs";
import { ensureDataDir, DB_PATH, CATALOGUE_PATH } from "./paths.ts";
import { openIndex } from "./index/schema.ts";
import type { Database } from "bun:sqlite";
import { reindexStore, listByRecency, titleOf, costOf, subagentCosts } from "./index/index.ts";
import { formatCost } from "./cost.ts";
import { openCatalogue, getAll, getRow, lifecycleOf, parentEdges, identityKeyOf, sessionsForCluster } from "./catalogue/db.ts";
import { openSessionIds } from "./cmux/liveness.ts";
import { toMember, buildClusterMap, renderClusterMap, clusterMapToJson, isCoreRole } from "./catalogue/cluster-map.ts";
import { describe as describeDisposition } from "./catalogue/disposition.ts";
import { whoami, rename, mark, tag, key, parent, role, gusWork, sessionEpic, project, setClusterCmd, status, name, stage, metaSet, meta } from "./catalogue/commands.ts";
import { newSession } from "./resume/new-session.ts";
import { syncTabs } from "./catalogue/sync-tabs.ts";
import { boardCommand } from "./catalogue/board-command.ts";
import { backfillTitles } from "./titler/queue.ts";
import { createTitler } from "./titler/codex.ts";
import { buildEngine, resolveEngine } from "./inference/engine.ts";
import { handoffInline } from "./resume/inline.ts";
import type { ResumeCommand } from "./resume/command.ts";
import { resumeSessionEntry } from "./resume/resume-session.ts";
import { resumeClusterEntry, resumeMany, type ClusterResumeSummary } from "./resume/resume-cluster.ts";
import { checkClusterGate } from "./cluster/manifest.ts";
import { clusterInitCommand } from "./cluster/init-command.ts";
import { resolveSelector, type SelectorKind } from "./resume/selector.ts";
import { syncRoles } from "./roles/sync-roles.ts";
import { rolesCommand } from "./catalogue/roles-command.ts";
import { hookRunCommand } from "./hooks/hook-run.ts";
import { statuslineCommand } from "./hooks/statusline-command.ts";
import { hooksCommand } from "./hooks/hooks-command.ts";
import { catchUpCommand } from "./hooks/catch-up-command.ts";
import { inboxCommand } from "./inbox/inbox-command.ts";
import { stateCommand } from "./state/state-command.ts";
import { groupingCommand } from "./state/grouping-command.ts";
import { catalogueExportCommand } from "./catalogue/export-command.ts";
import { identityCommand, identityResolveCommand } from "./catalogue/identity-command.ts";
import { sessionCommand } from "./catalogue/session-command.ts";
import { sessionFieldsCommand } from "./catalogue/session-fields-command.ts";
import { getCrashReporter, installCrashLog, summarizeArgv } from "./crashlog.ts";

const HELP = `ccs — find and resume any Claude Code session

Post-ADR-0089 model: sessions are the ephemeral instances; IDENTITIES hold durable state.
For durable per-work-unit writes (stage, status_line, meta.*, grouping, PR facts, review URL)
use \`ccs identity …\`; for per-run session state (title, parent, lifecycle) use \`ccs session …\`.

Usage:
  ccs                 Launch the session browser (TUI)
  ccs reindex [--titles]   Refresh the session index (--titles: also regenerate titles headless)
  ccs ls              Print indexed sessions (with catalogue badges)
  ccs tree            Constellation view: children grouped under their parent
  ccs whoami          Print the current session id (CLAUDE_CODE_SESSION_ID)

Identities (durable, per-work-unit — ADR-0089):
  ccs identity mint <key> --cluster=<c> --role=<r> [--grouping=<g>]
  ccs identity set <key> --field=value [...]      Universal or per-role attrs (schema-routed)
  ccs identity <key>                              Read one identity (+ per-role attrs join)
  ccs identity ls [--cluster=<c>] [--role=<r>] [--kind=core|fleet] [--completed] [--archived]
  ccs identity complete|archive|uncomplete <key>  Lifecycle (cascades to attached sessions)
  ccs identity path <key> [--new]                 Deterministic scratch dir for the identity
  ccs identity sessions <key>                     List sessions attached to this identity
  ccs identity lineage <key> [--search "<q>"]     Bodies in succession + transcript search
  ccs identity resolve --session <sid> [--json]   Session → identity key + facts (ADR-D1)

Sessions (ephemeral, per-run):
  ccs session <id|.>                              Read a session's row + linked identity
  ccs session set <id> --identity=<key> [--title="..."] [--parent=<id>] [--parked=<task>]
  ccs session unset <id> --identity|--title|--parent|--parked
  ccs session title <id> "text"                   Custom title + cmux tab sync
  ccs session complete|archive|uncomplete|unarchive <id>   Per-session lifecycle
  ccs session new [flags]                         Mint id, tag AT BIRTH, launch \`claude --session-id\`
    flags: --cluster --role --title --parent <id> --cwd <dir> --prompt "..." --permission-mode <mode>
           --pr-repo owner/repo --pr-number 123 --gus-work W-... · --print-id (reserve only)
  ccs session bump <id> [--note "..."]            Wake the session's cmux tab
  ccs session-fields <sid> --json '{...}' [--sensor <name>]  Atomic multi-field write (ADR-0078)

Legacy per-session verbs (still work; will migrate to \`ccs session …\` in a later sweep):
  ccs meta [<id>|.]                               Show a session's row (identity join included)
  ccs meta [<id>|.] <key> <value> [--off]         Set meta.<key> (mirrors to identity meta)
  ccs rename [<id>|.] "<name>"                    Alias for \`ccs session title\`
  ccs mark [<id>|.] --completed|--archived [--off]   Per-session lifecycle (core-identity safe)
  ccs tag [<id>|.] "<Entity>" [--remove]          Add/remove an entity tag
  ccs parent [<id>|.] <parent-id|.> [--off]       Set/clear the spawning parent
  ccs status [<id>|.] "<line>" [--off]            Freeform status pill (mirrors to identity.status_line)
  ccs name [<id>|.] "<short name>" [--off]        Short tab name (<=35 chars)
  ccs stage [<id>|.] [<value> --sensor <name>]    Read/write pipeline stage (sensor-only write)
  ccs new-session [flags]                         Legacy alias for \`ccs session new\`
  ccs bump-session <sid> [--note "..."]           Legacy alias for \`ccs session bump\`

Clusters & board:
  ccs cluster <c> [--expand] [--json]             Cluster map: members by role, live/lifecycle
  ccs cluster init <name> [--role <r>]            Scaffold a minimal cluster
  ccs cluster resume <c>                          (see \`ccs resume-cluster\`)
  ccs board <c> [--json|--text]                   Board: per-identity truth view
  ccs board <c> --identity <key> [--text]         Read one row by identity
  ccs board <c> --session <sid> [--text]          Read via session → identity resolve
  ccs board <c> --recompose <key> | --recompose-all   Sync recompose
  ccs catalogue export --cluster <c> [--role <r>] [--json]   Machine-readable projection (ADR-D1)
  ccs grouping upsert <id> --cluster=<c> --role=<r> [--label="..."] [--url=...]
  ccs decide <c> record|reopen|check|list ...     Decision ledger (dispositions)

Resume & tabs:
  ccs resume-session <id>                         Re-embody one identity (loops come back running)
  ccs resume-cluster <c>                          Resume every not-open identity in a cluster
  ccs resume <selector>                           id | #pr | owner/repo#pr | W-number | epic | role | cluster
                                                  (pin axis with --role|--pr|--gus|--epic|--cluster|--key; --dry-run)
  ccs sync-tabs [<selector>|.|--all]              Paint cmux tabs from catalogue metadata
  ccs reap-duplicates [--do]                      Close cmux dupes for sessions with >1 live \`claude --resume\`

Inbox & state:
  ccs inbox send|bump|drain|pending               Durable per-identity messaging (ADR-0028)
  ccs state get                                   Read a sensor state doc (--cluster <c> or --role <r> …)

Hooks & health:
  ccs hook run <name>                             Run a named ccs hook (session-start | stop) from stdin
  ccs hooks explain|lint                          Inspect ccs hook wiring
  ccs statusline                                  Print the statusline for the current session
  ccs self-check <id>                             Turn-end self-check sidecar
  ccs catch-up [<id>|.]                           Surface unseen cluster CHANGELOG entries
  ccs context-check [--json]                      Peak-context guard for long loops

Roles & skills:
  ccs roles [ls|upsert|rm]                        Manage the roles registry
  ccs sync-roles                                  Materialize roles into ~/.claude (symlink reconcile)
  ccs skills                                      Machine-wide skill registry (\`ccs skills --help\`)

  ccs --version       Print version
  ccs --help          Show this help
`;

/** Entry point. Routes argv to a command; returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  const reporter = installCrashLog();
  const args = argv.slice(2);
  const invocation = summarizeArgv(args);
  reporter.invocation(invocation);
  reporter.breadcrumb("cli.start", invocation);

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
      });
    case "tree":
      return tree({ all: args.includes("--all") });
    case "whoami":
      return whoami();
    case "meta": {
      const parsed = classifyMetaArgs(args.slice(1));
      switch (parsed.mode) {
        case "read":  return meta(parsed.id);
        case "set":   return metaSet(parsed.id, parsed.key, parsed.value, parsed.flags);
        case "error":
          console.error(parsed.message);
          return 1;
      }
    }
    case "rename":
      return rename(args[1], args.slice(2).filter((a) => !a.startsWith("--")).join(" "));
    case "mark":
      return mark(args[1], args.slice(2).filter((a) => a.startsWith("--")));
    case "tag":
      return tag(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "key":
      return key(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "parent":
      return parent(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "project":
      return project(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "set-cluster":
      return setClusterCmd(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "role":
      return role(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "gus-work":
      return gusWork(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "epic":
      return sessionEpic(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "status":
      // status takes a full freeform LINE, so join all non-flag args (not just the first token).
      return status(args[1], args.slice(2).filter((a) => !a.startsWith("--")).join(" ") || undefined, args.slice(2).filter((a) => a.startsWith("--")));
    case "name":
      // name takes a full short LINE (the display name), so join all non-flag args.
      return name(args[1], args.slice(2).filter((a) => !a.startsWith("--")).join(" ") || undefined, args.slice(2).filter((a) => a.startsWith("--")));
    case "stage": {
      // D5: --sensor <name> is a flag-value pair — pass the whole arg tail so stage() can find
      // both the flag AND its value. The value token doesn't start with -- so it wouldn't survive
      // the naive "flags = args starting with --" filter used elsewhere.
      const tail = args.slice(2);
      const value = tail.find((a, i) => !a.startsWith("--") && tail[i - 1] !== "--sensor");
      return stage(args[1], value, tail);
    }
    case "new-session":
      return newSession(args.slice(1));
    case "sync-tabs":
      return syncTabs(args.slice(1));
    case "hook": {
      // ADR-0089 step 8: `ccs hook <verb>` — hook plumbing noun (run/explain/lint).
      const verb = args[1];
      switch (verb) {
        case "run":
          return await hookRunCommand(args.slice(2));
        case "explain":
        case "lint":
          return hooksCommand([verb, ...args.slice(2)]);
        default:
          console.error("usage: ccs hook <run|explain|lint> ...");
          return 1;
      }
    }
    case "hooks":
      // Legacy: `ccs hooks <explain|lint>` — kept until step 10 hook prose sweep.
      return hooksCommand(args.slice(1));
    case "catch-up":
      // `ccs catch-up [<id>|.]` — surface unseen cluster CHANGELOG entries + advance the stamp
      // (ADR-0058). Per-tick companion to the catch-up start action, for long-lived loops.
      return catchUpCommand(args.slice(1));
    case "context-check": {
      const { contextCheckCommand } = await import("./hooks/context-check.ts");
      return contextCheckCommand(args.slice(1));
    }
    case "decide": {
      const { suppressCommand } = await import("./state/suppress.ts");
      return suppressCommand(args.slice(1));
    }
    case "bump-session": {
      const { bumpSessionCommand } = await import("./inbox/bump-session-command.ts");
      return bumpSessionCommand(args.slice(1));
    }
    case "reap-duplicates": {
      // `ccs reap-duplicates [--do]` — find sessions with >1 live `claude --resume <sid>` proc
      // and close the duplicate cmux workspaces (default is dry-run). Cleans up after a blind
      // liveness pass spawned a second embodiment of a session that was already running.
      const { reapCommand } = await import("./cmux/reap.ts");
      return reapCommand(args.slice(1));
    }
    case "statusline":
      // The Claude Code statusLine command (ADR-0027): reads session context on stdin,
      // prints the one-line status from ccs metadata. sync-roles materializes this into
      // settings.json's statusLine slot.
      return await statuslineCommand();
    case "inbox":
      return inboxCommand(args.slice(1));
    case "state":
      return stateCommand(args.slice(1));
    case "grouping":
      return groupingCommand(args.slice(1));
    case "roles":
      return rolesCommand(args.slice(1));
    case "sync-roles":
      return syncRolesCmd(args.includes("--dry-run"), args.includes("--hooks"));
    case "cluster": {
      // ADR-0089 step 8: `ccs cluster <verb>` — the cluster-scoped noun.
      const verb = args[1];
      switch (verb) {
        case "init":
          return clusterInitCommand(args.slice(2));
        case "board":
          // `ccs cluster board <c> [--json|--text|--identity=…|--recompose[=…]]`
          return boardCommand(args.slice(2));
        case "catch-up":
          return catchUpCommand(args.slice(2));
        case "decide": {
          const { suppressCommand } = await import("./state/suppress.ts");
          return suppressCommand(args.slice(2));
        }
        case "resume":
          return resumeCluster(args[2], args.includes("--dry-run"));
        case "reap-duplicates": {
          const { reapCommand } = await import("./cmux/reap.ts");
          return reapCommand(args.slice(2));
        }
        case "sync-roles":
          return syncRolesCmd(args.includes("--dry-run"), args.includes("--hooks"));
        default:
          // Bare cluster slug — the map view (was: `ccs cluster <c>`).
          return clusterView(verb, args.includes("--expand") || args.includes("--all"), args.includes("--json"));
      }
    }
    case "catalogue":
      // ADR-D1: `ccs catalogue export --cluster <c> ...` — the authorized read path for cluster
      // engines (compose_board.py etc). Replaces direct sqlite3 access to catalogue.db.
      return catalogueExportCommand(args.slice(1));
    case "identity":
      // ADR-0089 step 6: `ccs identity <verb>` — primary CLI surface for durable per-work-item
      // state. `resolve` stays as a legacy verb for engines until step 9 rewrites them.
      return identityCommand(args.slice(1));
    case "session-fields":
      // ADR-0078 finish-line: atomic multi-field write for cluster hot-path composers.
      // `ccs session-fields <sid> --json '{...}' [--sensor <name>]`
      return sessionFieldsCommand(args.slice(1));
    case "session":
      // ADR-0089 step 7: `ccs session <verb>` — per-session CLI noun. See session-command.ts.
      return await sessionCommand(args.slice(1));
    case "board":
      return boardCommand(args.slice(1));
    case "resume-session":
      return resumeSession(args[1], args.includes("--dry-run"));
    case "resume-cluster":
      return resumeCluster(args[1], args.includes("--dry-run"));
    case "resume":
      return resumeSelector(args.slice(1));
    case "self-check": {
      // `ccs self-check <session-id>` — the turn-end sidecar (ADR-0063 v2). Runs a cheap
      // claude -p against the session's recent transcript + rubric, executes any `ccs` state
      // updates the model decides on. Normally spawned detached by the worker Stop hook when
      // CCS_SELF_CHECK_MODE=sidecar; runnable by hand for debugging.
      const sid = args[1];
      if (!sid) {
        console.error("usage: ccs self-check <session-id>");
        return 1;
      }
      const { runSelfCheck } = await import("./hooks/self-check-sidecar.ts");
      return await runSelfCheck({ sessionId: sid });
    }
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
  getCrashReporter()?.breadcrumb("cli.reindex.start");
  ensureDataDir();
  const config = getConfig();
  if (!config) {
    getCrashReporter()?.breadcrumb("cli.reindex.failure", { stage: "config" });
    return 1;
  }

  const scan = scanStore(config.store.path);
  if (!scan.ok) {
    getCrashReporter()?.breadcrumb("cli.reindex.failure", { stage: "scan" });
    console.error(scan.error.message);
    return 1;
  }

  const db = openIndex(DB_PATH());
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
      const selection = resolveEngine(config);
      const engine = selection.name ? buildEngine(selection.name, config) : null;
      const titler = engine ? createTitler(engine) : null;
      process.stdout.write("Generating titles… ");
      const title = titler
        ? await backfillTitles(db, titler, {
            concurrency: config.titler.concurrency,
            maxAttempts: config.titler.maxAttempts,
            onProgress: (done, total) => {
              process.stdout.write(`\rGenerating titles… ${done}/${total}   `);
            },
          })
        : { generated: 0, failed: 0, skippedUnavailable: true };
      process.stdout.write("\n");
      if (title.skippedUnavailable) {
        console.log("  titling skipped — no inference engine (codex/claude) found on PATH");
      } else {
        console.log(`  ${title.generated} generated, ${title.failed} failed`);
      }
    }
  } finally {
    db.close();
  }
  getCrashReporter()?.breadcrumb("cli.reindex.success", { scanned: scan.value.length });
  return 0;
}

/** Launch the interactive browser: refresh the Index, then render the Ink app. */
async function launchTui(initialMode: "sessions" | "skills" = "sessions"): Promise<number> {
  const reporter = getCrashReporter();
  reporter?.breadcrumb("cli.tui.launch.start", { mode: initialMode });
  const config = getConfig();
  if (!config) {
    reporter?.breadcrumb("cli.tui.launch.failure", { stage: "config" });
    return 1;
  }
  ensureDataDir();

  const firstRun = !existsSync(DB_PATH());
  if (firstRun) console.log("First run — indexing your sessions…");

  const db = openIndex(DB_PATH());
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const { openSkillsDb } = await import("./skills/db.ts");
  const { SKILLS_DB_PATH } = await import("./paths.ts");
  const skillsDb = openSkillsDb(SKILLS_DB_PATH());
  const resumeRequest: { current: ResumeCommand | null } = { current: null };
  let stage: "scan" | "reindex" | "import" | "render" | "runtime" = "scan";
  try {
    reporter?.breadcrumb("cli.tui.scan.start");
    const scan = scanStore(config.store.path);
    if (scan.ok) {
      stage = "reindex";
      await reindexStore(db, scan.value, config.host.label);
      reporter?.breadcrumb("cli.tui.scan.success", { sessions: scan.value.length });
    } else {
      reporter?.breadcrumb("cli.tui.scan.failure");
    }

    stage = "import";
    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { Root } = await import("./tui/Root.tsx");
    stage = "render";
    reporter?.breadcrumb("cli.tui.render.mount");
    const app = render(createElement(Root, { db, catalogue, skillsDb, config, resumeRequest, initialMode }));
    stage = "runtime";
    await app.waitUntilExit();
    reporter?.breadcrumb("cli.tui.clean-exit");
  } catch (error) {
    reporter?.breadcrumb("cli.tui.launch.failure", { stage });
    throw error;
  } finally {
    db.close();
    catalogue.close();
    skillsDb.close();
  }

  // The TUI has fully unmounted (terminal restored) — now hand off to claude inline.
  if (resumeRequest.current) {
    return handoffInline(resumeRequest.current);
  }
  return 0;
}

/** Table of indexed sessions, joined with catalogue metadata + live open-state. */
function ls(opts: { all: boolean; loops: boolean }): number {
  ensureDataDir();
  const db = openIndex(DB_PATH());
  const cat = openCatalogue(CATALOGUE_PATH());
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
      const keyValue = identityKeyOf(c);
      if (!opts.all && lifecycle === "archived") continue;
      if (opts.loops && c?.kind !== "loop") continue;
      const d = describeDisposition(lifecycle, open.has(r.sessionId));
      // A child in the constellation gets a ↳ marker inside the (padded) title cell, keeping columns aligned.
      const childMark = c?.parentSessionId ? "↳ " : "";
      const title = pad(childMark + (c?.customTitle ?? r.title), 42);
      const badge = pad((c?.kind === "loop" ? "LOOP " : "") + d.label + (d.nudge ? "!" : ""), 16);
      const sk = pad(c?.role ? `⚙${c.role}` : "", 14);
      const key = pad(keyValue ? `⊞${keyValue}` : "", 18);
      const project = pad(r.projectName, 16);
      const age = pad(formatAge(r.lastTs), 5);
      const subCost = subCosts.get(r.sessionId) ?? subCosts.get(r.resumeId) ?? 0;
      const cost = pad(formatCost(r.costUSD + subCost), 7);
      console.log(`${srcMark[r.titleSource]} ${title} ${badge} ${sk}${key}${project} ${age} ${cost} ${r.msgCount}m`);
      shown++;
    }
    const hidden = rows.length - shown;
    console.log(
      `\n${shown} sessions  (★ native ✎ codex · LOOP=loop · ⚙=role · ↳=child · ⊞=key · !=open+parked/completed · $=API-equivalent cost incl. subagents)` +
        (hidden > 0 && !opts.all ? ` · ${hidden} hidden (archived/filtered; --all to show)` : ""),
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
  ensureDataDir();
  const db = openIndex(DB_PATH());
  const cat = openCatalogue(CATALOGUE_PATH());
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
      const s = catMap.get(id)?.role;
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

/** Render the cluster map for a cluster: members grouped by role, liveness, how to reach each. */
function clusterView(clusterSlug: string | undefined, expand = false, asJson = false): number {
  if (!clusterSlug) {
    console.error("ccs: missing cluster slug. Usage: ccs cluster <cluster> [--expand] [--json]");
    return 1;
  }
  const db = openIndex(DB_PATH());
  const cat = openCatalogue(CATALOGUE_PATH());
  try {
    // Liveness is surface-keyed (exact) via the cmux bridge, not cwd-approximate: a session
    // is live iff its id or resumeId has a live surface (ADR-0014/0040).
    const open = openSessionIds();
    const members = sessionsForCluster(cat, clusterSlug).map((sid) => {
      const row = getRow(cat, sid)!;
      const ir = db
        .query("SELECT cwd, resume_id FROM sessions WHERE session_id = $id")
        .get({ $id: sid }) as { cwd: string | null; resume_id: string | null } | null;
      const cwd = ir?.cwd ?? null;
      const live = open.has(sid) || (!!ir?.resume_id && open.has(ir.resume_id));
      return toMember(row, cwd, ir?.resume_id ?? null, live);
    });
    const map = buildClusterMap(clusterSlug, members);
    if (asJson) {
      // Machine-readable roster for AGENTS to consume each tick (control/concierge/scout/…):
      // all sessions, core + fleet, live/lifecycle, work-unit, + a closedWithWork roll-up.
      console.log(JSON.stringify(clusterMapToJson(map)));
      return 0;
    }
    if (members.length === 0) {
      console.log(`cluster ${clusterSlug}: no members (nothing tagged cluster=${clusterSlug}).`);
      return 0;
    }
    console.log(renderClusterMap(map, expand));
    return 0;
  } finally {
    db.close();
    cat.close();
  }
}

/** Resume all sessions in a system (idempotent reconcile). */
/** `ccs resume-session <id>` — the core op: re-embody one identity (ADR-0015). */
function resumeSession(sessionId: string | undefined, dryRun: boolean): number {
  if (!sessionId) {
    console.error("ccs: missing session id. Usage: ccs resume-session <id> [--dry-run]");
    return 1;
  }
  const db = openIndex(DB_PATH());
  const cat = openCatalogue(CATALOGUE_PATH());
  try {
    const res = resumeSessionEntry(db, cat, sessionId, { dryRun });
    switch (res.status) {
      case "resumed":
        console.log(`ccs: ${dryRun ? "would resume" : "resumed"} ${sessionId}${res.note ? ` (${res.note})` : ""}`);
        return 0;
      case "already-open":
        console.log(`ccs: ${sessionId} is already open — nothing to do`);
        return 0;
      case "not-indexed":
        console.error(`ccs: ${sessionId} is not indexed (run \`ccs reindex\`)`);
        return 1;
      case "spawn-failed":
        console.error(`ccs: failed to spawn cmux workspace for ${sessionId}`);
        return 1;
      case "liveness-unreadable":
        console.error(
          "ccs: cmux liveness is unreadable (cmux down, socket unauthed, or store unparseable) — " +
            "aborting to avoid duplicating a session that may be running. Nothing spawned.",
        );
        return 1;
      case "cwd-unreadable":
        console.error(`ccs: cannot resume ${sessionId}: ${res.error}`);
        return 1;
    }
  } finally {
    db.close();
    cat.close();
  }
}

/** `ccs sync-roles` — materialize the roles registry into ~/.claude (ADR-0022/0034). */
function syncRolesCmd(dryRun: boolean, hookFlag: boolean): number {
  // Roles are read from config FILES now (ADR-0050), so no catalogue is opened.
  const r = syncRoles({ dryRun, hooks: hookFlag });
  const verb = dryRun ? "would create" : "created";
  console.log(`ccs: sync-roles — ${verb} ${r.created}, pruned ${r.pruned}${hookFlag ? `, hooks ${r.hooks}` : ""}`);
  if (r.collisions.length) {
    console.warn(`ccs: skipped ${r.collisions.length} (a non-ccs file is in the way):`);
    for (const c of r.collisions) console.warn(`  ${c}`);
  }
  return 0;
}

/**
 * Print a per-session preview of a resume-cluster pass, split into CORE (singletons — control /
 * concierge / …) and FLEET (workers) sections. Lists every non-retired member so you can see the
 * full picture: sessions that will be resumed, ones already open (skipped, so you can tell which
 * of the totals is already running), and superseded duplicates. Retired stays hidden — those are
 * done and never revived. Each row uses a leading glyph so the disposition is scannable:
 *   → resume (or ✓ resumed, live run)   ● already open   ⊘ superseded
 * The label prefers the AI shortname (meta.shortname) with the PR number, then the stored PR
 * title, then the role, then the sid — matching what a worker's tab renders.
 */
function printResumeClusterPreview(verb: string, s: ClusterResumeSummary): void {
  const KEEP: ReadonlySet<ClusterResumeSummary["perSession"][number]["result"]> = new Set([
    "resumed", "already-open", "superseded",
  ]);
  const shown = s.perSession.filter((m) => KEEP.has(m.result));
  if (shown.length === 0) return;
  const core: typeof shown = [], fleet: typeof shown = [];
  for (const m of shown) (isCoreRole(m.role) ? core : fleet).push(m);
  const label = (m: typeof shown[0]): string => {
    const clean = m.shortname?.trim() || m.title?.replace(/^(#\d+\s+)+/, "").trim() || null;
    if (m.prNumber && clean) return `#${m.prNumber} ${clean}`;
    if (m.prNumber) return `#${m.prNumber}`;
    if (clean) return clean;
    if (m.role) return m.role;
    return m.sessionId.slice(0, 8);
  };
  const glyph = (m: typeof shown[0]): string => {
    if (m.result === "already-open") return "●";
    if (m.result === "superseded") return "⊘";
    return verb === "resumed" ? "✓" : "→";
  };
  const suffix = (m: typeof shown[0]): string => {
    if (m.result === "already-open") return " (already open)";
    if (m.result === "superseded") return " (superseded)";
    return "";
  };
  // Sort each section: resume-candidates first (the action), then already-open, then superseded —
  // so "what will happen" reads before "what's already fine" reads before "what got deduped".
  const rank: Record<string, number> = { "resumed": 0, "already-open": 1, "superseded": 2 };
  const section = (title: string, items: typeof shown) => {
    if (items.length === 0) return;
    const sorted = [...items].sort((a, b) => (rank[a.result] ?? 9) - (rank[b.result] ?? 9));
    console.log(`\n  [${title}] (${items.length})`);
    for (const m of sorted) {
      console.log(`    ${glyph(m)} ${m.sessionId.slice(0, 8)} · ${label(m)}${suffix(m)}`);
    }
  };
  section("core", core);
  section("fleet", fleet);
}

/** `ccs resume-cluster <cluster>` — a thin loop over resume-session (ADR-0015). */
function resumeCluster(cluster: string | undefined, dryRun: boolean): number {
  if (!cluster) {
    console.error("ccs: missing cluster. Usage: ccs resume-cluster <cluster> [--dry-run]");
    return 1;
  }
  // ADR-0058 inter-layer version gate: refuse to bring a cluster online whose config declares a
  // ccs version we can't honor (major-version gap); warn-and-proceed on a minor gap or a bad
  // manifest. This is the loud failure that a silent tool↔config schema skew otherwise lacks.
  const gate = checkClusterGate(cluster, pkg.version);
  if (gate.status === "refuse") {
    console.error(`ccs: ${gate.message}. Upgrade ccs (or relax requires_ccs). Nothing spawned.`);
    return 1;
  }
  if (gate.status === "warn") console.warn(`ccs: ${gate.message}`);
  const db = openIndex(DB_PATH());
  const cat = openCatalogue(CATALOGUE_PATH());
  try {
    const s = resumeClusterEntry(db, cat, cluster, { dryRun });
    if (s.abortedUnreadable) {
      console.error(
        `ccs: cluster "${cluster}" — cmux liveness is unreadable (cmux down, socket unauthed, or ` +
          "store unparseable). Aborted to avoid duplicating a running fleet. Nothing spawned.",
      );
      return 1;
    }
    const verb = dryRun ? "would resume" : "resumed";
    // A dry-run without a per-session preview is a black box — "would resume 18" doesn't say WHICH
    // 18. Split by role topology (core singletons vs fleet workers, ADR-0069) and print each session
    // being acted on with the label you'd recognize (PR + shortname / title / role / sid). Retired
    // and already-open members are noise for the preview — they aren't being acted on — so we skip
    // them; superseded stays visible so you see when a duplicate work-unit gets deduped.
    printResumeClusterPreview(verb, s);
    console.log(
      `\nccs: cluster "${cluster}" — ${verb} ${s.resumed}, ${s.alreadyOpen} already open, ` +
        `${s.superseded} superseded, ${s.retired} retired, ${s.notIndexed} not indexed` +
        `${s.failed ? `, ${s.failed} failed` : ""}`,
    );
    return s.failed > 0 ? 1 : 0;
  } finally {
    db.close();
    cat.close();
  }
}

/**
 * `ccs resume <selector>` — resume anything that identifies a session or a group of them: a
 * session id, a PR (`#123` / `owner/repo#123`), a GUS work item (`W-1234567`), an epic shortname,
 * a role, or a cluster. Flags pin the axis (`--role`, `--pr`, `--gus`, `--epic`, `--cluster`,
 * `--key`) and skip shape inference. One match → resume-session semantics; many → cluster
 * semantics (one live worker per work-unit). All routes share the single resume core (resumeMany).
 */
export function resumeSelector(args: string[]): number {
  const token = args.find((a) => !a.startsWith("--"));
  if (!token) {
    console.error(
      "ccs: missing selector. Usage: ccs resume <id|#pr|W-number|epic|role|cluster> [--role|--pr|--gus|--epic|--cluster|--key] [--dry-run]",
    );
    return 1;
  }
  const dryRun = args.includes("--dry-run");
  const pin: SelectorKind | undefined =
    args.includes("--role") ? "role"
    : args.includes("--pr") ? "pr"
    : args.includes("--gus") ? "gus-work"
    : args.includes("--epic") ? "epic"
    : args.includes("--cluster") ? "cluster"
    : args.includes("--key") ? "key"
    : undefined;
  const cluster = flagValue(args, "--in") ?? flagValue(args, "--cluster-scope");

  // On a fresh CCS_ROOT the cache dir doesn't exist yet; opening either DB
  // without this would raise SQLITE_CANTOPEN and dump a raw stack trace
  // instead of the intended zero-match error message.
  ensureDataDir();
  const db = openIndex(DB_PATH());
  const cat = openCatalogue(CATALOGUE_PATH());
  try {
    const sel = resolveSelector(cat, db, token, { pin, cluster });
    if (!sel) {
      console.error(`ccs: "${token}" didn't match any session, PR, work item, epic, role, or cluster`);
      return 1;
    }
    if (sel.sessionIds.length === 0) {
      console.error(`ccs: ${sel.label} matched no sessions`);
      return 1;
    }
    const s = resumeMany(db, cat, sel.sessionIds, { dryRun });
    if (s.abortedUnreadable) {
      console.error(
        `ccs: ${sel.label} — cmux liveness is unreadable (cmux down, socket unauthed, or store ` +
          "unparseable). Aborted to avoid duplicating a running session. Nothing spawned.",
      );
      return 1;
    }
    const verb = dryRun ? "would resume" : "resumed";
    console.log(
      `ccs: ${sel.label} (${sel.sessionIds.length} session${sel.sessionIds.length === 1 ? "" : "s"}) — ${verb} ${s.resumed}, ` +
        `${s.alreadyOpen} already open, ${s.superseded} superseded, ${s.retired} retired, ` +
        `${s.notIndexed} not indexed${s.failed ? `, ${s.failed} failed` : ""}`,
    );
    return s.failed > 0 ? 1 : 0;
  } finally {
    db.close();
    cat.close();
  }
}

/**
 * Classify `ccs meta …` arg-shape into READ / SET / ERROR. Kept as a pure exported helper so the
 * routing contract is unit-testable (cli.ts's switch dispatch is otherwise private to main).
 *
 * The disambiguation problem: the help text has always advertised BOTH shapes on `ccs meta`
 * (read: `ccs meta [<id>|.]`; set: `ccs meta [<id>|.] <key> <value>`), but the dispatch used to
 * unconditionally call the READ handler and DROP any extra args. So `ccs meta . milad_review
 * approved` silently no-op'd — no error, no write. Caught 2026-07-13 when a day of concierge
 * "record Milad's approval" writes were quietly ignored.
 *
 * Rules:
 *   - 0 positionals, no --off       → READ current session
 *   - 1 positional, no --off        → READ that arg's session (or current if it looks like a key)
 *   - >=3 positionals               → SET (first is id-hint, then key, then value)
 *   - 2 positionals, first is id-hint (`.` or hex-id) → SET (id, key, value)
 *   - 2 positionals, first is NOT an id-hint → SET (id=`.`, key=pos0, value=pos1)
 *   - 1 positional + --off          → CLEAR (id=`.`, key=pos0)
 *   - 2 positionals + --off, first is id-hint → CLEAR (id, key)
 *   - anything ambiguous (e.g. >1 positional in a shape that doesn't match set) → ERROR
 *
 * "id-hint" = literally `.` OR a hex-run of >=8 chars (matches a session-id prefix or full uuid).
 * Everything else is treated as a key name. This heuristic accepts `ccs meta abc12345 my_key val`
 * as a set, and `ccs meta my_key val` as a set on the current session — matching what users type.
 */
export type MetaArgs =
  | { mode: "read"; id: string | undefined }
  | { mode: "set"; id: string; key: string; value: string | undefined; flags: string[] }
  | { mode: "error"; message: string };

const META_ID_HINT = /^[0-9a-f-]{8,}$/i;
const isIdHint = (s: string): boolean => s === "." || META_ID_HINT.test(s);
const USAGE = [
  "usage:",
  "  ccs meta [<id>|.]                          # read",
  "  ccs meta [<id>|.] <key> <value>            # set (value JSON-parsed if scalar; else stored as string)",
  "  ccs meta [<id>|.] <key> --off              # clear",
].join("\n");

export function classifyMetaArgs(argsAfterCommand: string[]): MetaArgs {
  const pos = argsAfterCommand.filter((a) => !a.startsWith("--"));
  const flags = argsAfterCommand.filter((a) => a.startsWith("--"));
  const off = flags.includes("--off");

  if (!off && pos.length === 0) return { mode: "read", id: undefined };
  if (!off && pos.length === 1) return { mode: "read", id: pos[0] };

  // set/clear paths
  if (pos.length >= 3) {
    const [id, key, value] = pos;
    if (!isIdHint(id!)) {
      return { mode: "error", message: `ccs meta: first arg "${id}" doesn't look like a session id or "."\n${USAGE}` };
    }
    return { mode: "set", id: id!, key: key!, value, flags };
  }
  if (pos.length === 2 && !off) {
    // Ambiguous: `<id-hint> <key>` (missing value) vs `<key> <value>` (implicit id=`.`).
    // Rule: if the first positional is an id-hint we STILL treat this as a set-missing-value and
    // fail loudly via metaSet's usage error, rather than guessing. This catches the pr-agent
    // typo `ccs meta abc12345 milad_review` (no value) instead of silently no-op'ing.
    if (isIdHint(pos[0]!)) {
      return { mode: "error", message: `ccs meta: value required (or use --off to clear)\n${USAGE}` };
    }
    // <key> <value> — implicit id=`.`
    return { mode: "set", id: ".", key: pos[0]!, value: pos[1], flags };
  }
  if (pos.length === 2 && off) {
    if (!isIdHint(pos[0]!)) {
      return { mode: "error", message: `ccs meta: with --off, first arg must be an id or "."\n${USAGE}` };
    }
    return { mode: "set", id: pos[0]!, key: pos[1]!, value: undefined, flags };
  }
  if (pos.length === 1 && off) {
    return { mode: "set", id: ".", key: pos[0]!, value: undefined, flags };
  }
  if (pos.length === 0 && off) {
    return { mode: "error", message: `ccs meta: --off needs a key\n${USAGE}` };
  }
  return { mode: "error", message: `ccs meta: unrecognized args\n${USAGE}` };
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
