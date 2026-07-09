import { existsSync } from "node:fs";
import { ensureDataDir, DATA_DIR, CATALOGUE_PATH, MERGE_PATH } from "../paths.ts";
import { loadConfig, type Config } from "../config.ts";
import { formatAge } from "../store.ts";
import { openCatalogue, lifecycleOf } from "./db.ts";
import { buildMerge, discoverSources, openMerge, mergedRows, mergedAt } from "./merge.ts";
import { ownerOf as mergeOwnerOf } from "./merge.ts";
import { sendIntent, applyIntents, applyIntentsFromInbox } from "./intents.ts";
import { foreignOwner, localHostName, sameHost } from "./ownership.ts";
import { MUTATION_OPS, type Mutation } from "./command.ts";
import { normalizeMutationValue } from "./command.ts";
import { SESSION_ID_RE } from "./commands.ts";

/**
 * CLI surface for the fleet-wide catalogue (issue 33): the Merged View (`ccs merge`,
 * `ccs ls --fleet`) and edit intents (`ccs intent`, `ccs apply-intents`). Command bodies live
 * here — cli.ts stays a router.
 */

function getConfig(): Config | null {
  const result = loadConfig();
  if (!result.ok) {
    console.error(result.error.message);
    return null;
  }
  return result.value;
}

/** Pad/truncate a string to an exact display width. */
function pad(text: string, width: number): string {
  const t = text.length > width ? text.slice(0, width - 1) + "…" : text;
  return t.padEnd(width);
}

/** Build the merged view from every replica + the local data dir (merge Host only). */
export function merge(): number {
  const config = getConfig();
  if (!config) return 1;
  ensureDataDir();
  if (!existsSync(config.merge.replicasRoot)) {
    // A spoke machine rebuilding from local data alone would CLOBBER its pulled fleet view
    // (and silently disarm every foreign-row guard). Only the merge Host builds.
    console.error(
      `no replicas at ${config.merge.replicasRoot} — this isn't the merge host. ` +
        "Fetch the fleet view instead: ccs merge --pull",
    );
    return 1;
  }
  const sources = discoverSources(DATA_DIR, localHostName(), config.merge.replicasRoot);
  const stats = buildMerge(sources, MERGE_PATH, new Date().toISOString());
  console.log(
    `merged ${stats.sessions} sessions (${stats.tags} tags) from ${stats.sources} host${stats.sources === 1 ? "" : "s"}: ` +
      sources.map((s) => s.host).join(", "),
  );
  for (const s of stats.skipped) console.error(`  skipped unreadable source — ${s}`);
  console.log(`→ ${MERGE_PATH}`);
  return stats.skipped.length ? 1 : 0;
}

/** Fetch the merge Host's merged view (spoke machines read, never build). */
export function mergePull(): number {
  const config = getConfig();
  if (!config) return 1;
  ensureDataDir();
  const remote = `${config.merge.remote}:.claude-sessions/merge.db`;
  const proc = Bun.spawnSync(
    ["rsync", "-a", "-e", "ssh -o BatchMode=yes -o ConnectTimeout=10", remote, MERGE_PATH],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    const errText = new TextDecoder().decode(proc.stderr).trim();
    console.error(`merge pull failed (${config.merge.remote} unreachable or no merge built there): ${errText}`);
    return 1;
  }
  const db = openMerge(MERGE_PATH);
  const at = db ? mergedAt(db) : null;
  db?.close();
  console.log(`pulled merged view from ${config.merge.remote} (built ${at ?? "?"})`);
  return 0;
}

/** Fleet-wide listing from the merged view: every Host's sessions, Host column first. */
export function lsFleet(opts: { host?: string; role?: string; all?: boolean }): number {
  const db = openMerge(MERGE_PATH);
  if (!db) {
    console.log("No merged view yet. Build it on the merge host (`ccs merge`) or fetch it (`ccs merge --pull`).");
    return 1;
  }
  try {
    const local = localHostName();
    let shown = 0;
    let hidden = 0;
    for (const r of mergedRows(db)) {
      if (opts.host && !sameHost(r.host, opts.host)) continue;
      if (opts.role && r.role !== opts.role) continue;
      const lifecycle = lifecycleOf(r);
      if (!opts.all && lifecycle === "archived") {
        hidden++;
        continue;
      }
      const here = sameHost(r.host, local);
      const host = pad((here ? "· " : "⇄ ") + r.host, 18);
      const title = pad(r.customTitle ?? r.title ?? "(catalogue-only row)", 42);
      const badge = pad((r.kind === "loop" ? "LOOP " : "") + (lifecycle === "idle" ? "" : lifecycle), 14);
      const rl = pad(r.role ? `◈${r.role}` : "", 14);
      const sk = pad(r.skill ? `⚙${r.skill}` : "", 14);
      const age = pad(r.lastTs ? formatAge(r.lastTs) : "?", 5);
      console.log(`${host} ${title} ${badge}${rl}${sk}${age}`);
      shown++;
    }
    const at = mergedAt(db);
    console.log(
      `\n${shown} sessions fleet-wide  (· local ⇄ other host · ◈ role · ⚙ skill) · merged ${at ?? "?"}` +
        (hidden > 0 && !opts.all ? ` · ${hidden} archived hidden (--all)` : ""),
    );
  } finally {
    db.close();
  }
  return 0;
}

/** Emit a catalogue edit for a foreign row as an edit-intent fleet envelope. */
export function intent(rest: string[]): number {
  const config = getConfig();
  if (!config) return 1;
  const positionals = rest.filter((a) => !a.startsWith("--"));
  const off = rest.includes("--off");
  const [idArg, op, rawValue] = positionals;
  const usage = `usage: ccs intent <session-id|.> <op> [<value>] [--off]   ops: ${MUTATION_OPS.join("|")}`;
  const id = !idArg || idArg === "." || idArg === "self" ? process.env.CLAUDE_CODE_SESSION_ID : idArg;
  if (!id || !op || !MUTATION_OPS.includes(op as Mutation["op"]) || (!rawValue && !off)) {
    console.error(usage);
    return 1;
  }
  // Same value discipline as every other producer: normalize spellings here, so "completed
  // yes" can't transit the fleet and un-complete a session on arrival.
  const norm = normalizeMutationValue(op as Mutation["op"], off ? null : rawValue!);
  if ("skip" in norm) {
    console.error(`${op} needs a value (nothing to ${op} with --off)`);
    return 1;
  }
  if (op === "parent" && norm.value !== null && !SESSION_ID_RE.test(norm.value)) {
    console.error(`parent must be a session id (UUID), got: ${norm.value}`);
    return 1;
  }
  const owner = foreignOwner(id);
  if (!owner) {
    // Our own row (or unknown to the merged view): a local write is simpler and instant.
    console.error(
      `${id.slice(0, 8)}… is not a known foreign row — edit it directly (ccs ${op} ${id} …). ` +
        "Intents are for rows the merged view assigns to another Host.",
    );
    return 1;
  }
  const result = sendIntent({
    fleetCli: config.fleet.cli,
    toRole: config.fleet.intentRole,
    fromLabel: `ccs-${localHostName()}`,
    ownerHost: owner,
    mutations: [{ sessionId: id, op: op as Mutation["op"], value: norm.value }],
  });
  if (!result.ok) {
    console.error(`intent not sent: ${result.error.message}`);
    return 1;
  }
  console.log(result.value);
  console.log(
    `edit intent for ${id.slice(0, 8)}… (${op}) queued for ${owner} in ${config.fleet.intentRole}'s inbox — ` +
      `applied on ${owner}'s next apply-intents pass, visible after its next merge`,
  );
  return 0;
}

/** Apply edit intents: from the applier role's inbox (selective, fleet-correct) or stdin. */
export async function applyIntentsCommand(stateDir: string | undefined): Promise<number> {
  ensureDataDir();
  const local = localHostName();
  const mergeDb = openMerge(MERGE_PATH);
  if (!mergeDb) console.error("note: no merged view here — per-row ownership refinement skipped");
  const catalogue = openCatalogue(CATALOGUE_PATH);
  try {
    const opts = {
      localHost: local,
      ownerOf: (id: string) => (mergeDb ? mergeOwnerOf(mergeDb, id) : null),
      now: new Date().toISOString(),
    };
    const summary = stateDir
      ? applyIntentsFromInbox(catalogue, stateDir, opts)
      : applyIntents(
          catalogue,
          (await new Response(Bun.stdin.stream()).text()).split("\n").filter((l) => l.trim()),
          opts,
        );
    for (const note of summary.notes) console.log(note);
    console.log(`${summary.applied} applied, ${summary.skipped} skipped`);
  } finally {
    catalogue.close();
    mergeDb?.close();
  }
  return 0;
}
