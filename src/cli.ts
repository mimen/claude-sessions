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
import { toMember, buildClusterMap, renderClusterMap } from "./catalogue/cluster-map.ts";
import { describe as describeDisposition } from "./catalogue/disposition.ts";
import { whoami, rename, mark, tag, key, parent, role, gusWork, sessionEpic, project, setClusterCmd, status, activity, stage, metaSet, meta } from "./catalogue/commands.ts";
import { newSession } from "./resume/new-session.ts";
import { syncTabs } from "./catalogue/sync-tabs.ts";
import { backfillTitles } from "./titler/queue.ts";
import { createTitler } from "./titler/codex.ts";
import { buildEngine, resolveEngine } from "./inference/engine.ts";
import { handoffInline } from "./resume/inline.ts";
import type { ResumeCommand } from "./resume/command.ts";
import { resumeSessionEntry } from "./resume/resume-session.ts";
import { resumeClusterEntry, resumeMany } from "./resume/resume-cluster.ts";
import { checkClusterGate } from "./cluster/manifest.ts";
import { resolveSelector, type SelectorKind } from "./resume/selector.ts";
import { syncRoles } from "./roles/sync-roles.ts";
import { backfillWorkUnits } from "./catalogue/backfill-work-units.ts";
import { rolesCommand } from "./catalogue/roles-command.ts";
import { registerSessionCommand } from "./hooks/register-command.ts";
import { hookRunCommand } from "./hooks/hook-run.ts";
import { statuslineCommand } from "./hooks/statusline-command.ts";
import { hooksCommand } from "./hooks/hooks-command.ts";
import { catchUpCommand } from "./hooks/catch-up-command.ts";
import { inboxCommand } from "./inbox/inbox-command.ts";
import { stateCommand } from "./state/state-command.ts";
import { groupingCommand } from "./state/grouping-command.ts";

const HELP = `ccs — find and resume any Claude Code session

Usage:
  ccs                 Launch the session browser (TUI)
  ccs reindex         Refresh the session index from the store
  ccs reindex --titles   Also (re)generate titles, headless (cron-friendly)
  ccs ls              Print indexed sessions (with catalogue badges)
  ccs tree            Constellation view: children grouped under their parent
  ccs whoami          Print the current session id (CLAUDE_CODE_SESSION_ID)
  ccs meta [<id>|.]   Show a session's catalogue metadata (. = current session)
  ccs rename [<id>|.] "<name>"   Set a custom title (+ sync cmux workspace name)
  ccs mark [<id>|.] --completed|--archived [--off]   Set lifecycle flags (control-owned)
  ccs tag [<id>|.] "<Entity>" [--remove]   Add/remove an entity tag
  ccs key [<id>|.] <slug> [--off]   Assign/clear the session's identity key (canonical)
  ccs parent [<id>|.] <parent-id|.> [--off]   Set/clear the spawning parent session
  ccs project [<id>|.] <label> [--off]   Set/clear the project/initiative label
  ccs set-cluster [<id>|.] <slug> [--off]   Set/clear the cluster grouping
  ccs status [<id>|.] "<line>" [--off]   Set a short freeform status shown on the session's tab
  ccs activity [<id>|.] <value> [--off]   Set the activity (cluster defines the vocabulary; --off = dormant)
  ccs stage [<id>|.] <value> [--off]   Generic stage setter (cluster defines + the tool enforces the vocabulary)
  ccs meta [<id>|.] <key> <value> [--off]   Set a key in the session's generic meta map (ADR-0060/0064)
  ccs new-session [flags]   Mint a session id, tag its metadata AT BIRTH, then launch \`claude --session-id\`
                            flags: --cluster --role --kind loop|session --project --key
                                   --title --parent <id> --cwd <dir> --prompt "<text>"
                                   --permission-mode <mode> · --print-id (reserve only, don't launch)
  ccs sync-tabs [<selector>|.|--all]   Paint cmux tabs from catalogue metadata (. | id | #pr | role | cluster | --all)
  ccs cluster <system>  Show the cluster map: members by role, liveness, how to reach each
  ccs inbox send|bump|drain|pending  Durable per-identity messaging; bump also wakes a live tab (ADR-0028)
  ccs state get|set|merge  Durable state store (--cluster <c> or --role <r> …) (ADR-0031)
  ccs hook run <name>   Run a named ccs hook (session-start | stop) from its stdin payload
  ccs register-session  (alias for 'ccs hook run session-start')
  ccs roles [ls|upsert|rm]  Manage the roles registry (definitions sync-roles/resume use)
  ccs sync-roles        Materialize the roles registry into ~/.claude (symlink reconcile)
  ccs resume-session <id>  Re-embody one identity (the core op; loops come back running)
  ccs resume-cluster <c>   Resume every not-open identity in a cluster (loop over resume-session)
  ccs resume <selector>  Resume by anything: id | #pr | owner/repo#pr | W-number | epic | role | cluster
                         (pin the axis with --role|--pr|--gus|--epic|--cluster|--key; --dry-run to preview)
  ccs skills          Machine-wide skill registry with usage data (ccs skills --help)
  ccs catch-up [<id>|.]  Surface unseen cluster CHANGELOG entries + advance the seen stamp (exit 2 if a restart is needed)
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
    case "key":
      return key(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "parent":
      return parent(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "project":
      return project(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "set-cluster":
    case "system": // back-compat alias
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
    case "activity":
      return activity(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "stage":
      return stage(args[1], args.slice(2).find((a) => !a.startsWith("--")), args.slice(2).filter((a) => a.startsWith("--")));
    case "meta-set": {
      const pos = args.slice(2).filter((a) => !a.startsWith("--"));
      return metaSet(args[1], pos[0], pos[1], args.slice(2).filter((a) => a.startsWith("--")));
    }
    case "new-session":
    case "new":
      return newSession(args.slice(1));
    case "sync-tabs":
      return syncTabs(args.slice(1));
    case "hook":
      // `ccs hook run <name>` — the named-hook dispatcher (settings.json wires these)
      if (args[1] === "run") return await hookRunCommand(args.slice(2));
      console.error("usage: ccs hook run <name>");
      return 1;
    case "hooks":
      // `ccs hooks <explain|lint>` — layered-hook observability (ADR-0045)
      return hooksCommand(args.slice(1));
    case "catch-up":
      // `ccs catch-up [<id>|.]` — surface unseen cluster CHANGELOG entries + advance the stamp
      // (ADR-0058). Per-tick companion to the catch-up start action, for long-lived loops.
      return catchUpCommand(args.slice(1));
    case "register-session":
      return await registerSessionCommand(); // back-compat alias for `hook run session-start`
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
    case "backfill-work-units":
      // one-time ADR-0057 migration: link existing anchored rows to a work-unit entity
      return backfillWorkUnits(args.slice(1));
    case "cluster":
      return clusterView(args[1], args.includes("--expand") || args.includes("--all"));
    case "resume-session":
      return resumeSession(args[1], args.includes("--dry-run"));
    case "resume-cluster":
      return resumeCluster(args[1], args.includes("--dry-run"));
    case "resume":
      return resumeSelector(args.slice(1));
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
  return 0;
}

/** Launch the interactive browser: refresh the Index, then render the Ink app. */
async function launchTui(initialMode: "sessions" | "skills" = "sessions"): Promise<number> {
  const config = getConfig();
  if (!config) return 1;
  ensureDataDir();

  const firstRun = !existsSync(DB_PATH());
  if (firstRun) console.log("First run — indexing your sessions…");

  const db = openIndex(DB_PATH());
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const { openSkillsDb } = await import("./skills/db.ts");
  const { SKILLS_DB_PATH } = await import("./paths.ts");
  const skillsDb = openSkillsDb(SKILLS_DB_PATH());
  const resumeRequest: { current: ResumeCommand | null } = { current: null };
  try {
    const scan = scanStore(config.store.path);
    if (scan.ok) await reindexStore(db, scan.value, config.host.label);

    const { render } = await import("ink");
    const { createElement } = await import("react");
    const { Root } = await import("./tui/Root.tsx");
    const app = render(createElement(Root, { db, catalogue, skillsDb, config, resumeRequest, initialMode }));
    await app.waitUntilExit();
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
function clusterView(clusterSlug: string | undefined, expand = false): number {
  if (!clusterSlug) {
    console.error("ccs: missing cluster slug. Usage: ccs cluster <cluster>");
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
    if (members.length === 0) {
      console.log(`cluster ${clusterSlug}: no members (nothing tagged cluster=${clusterSlug}).`);
      return 0;
    }
    console.log(renderClusterMap(buildClusterMap(clusterSlug, members), expand));
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
    console.log(
      `ccs: cluster "${cluster}" — ${verb} ${s.resumed}, ${s.alreadyOpen} already open, ` +
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
function resumeSelector(args: string[]): number {
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
