/**
 * `ccs identity <verb>` — ADR-0089 step 6. The primary CLI surface for durable per-work-item
 * state. Reads join identities × per-role table; writes route universal vs per-role fields.
 *
 *   ccs identity <key>                              read one (default verb)
 *   ccs identity list [--cluster=c] [--role=r] [--grouping=g] [--kind=fleet|core]
 *                     [--completed] [--archived]
 *   ccs identity mint <key> --cluster=c --role=r [--grouping=g]
 *   ccs identity set <key> --field=value [--other=value …]     universal + per-role fields
 *                                                              meta.<key>=value merges JSON
 *                                                              --unset=field clears one
 *   ccs identity complete|archive|uncomplete <key>              lifecycle
 *   ccs identity path <key> [--new]                             scratch dir
 *   ccs identity sessions <key>                                 attached session ids
 *   ccs identity lineage <key> [--search "<q>"]                 bodies in succession + transcript search
 *   ccs identity resolve --session <sid> [--json]               (legacy — kept for engines)
 *
 * The legacy `resolve` verb is kept until step 9 rewrites engine callers.
 */
import { openCatalogue, getRow, deriveIdentityKey } from "./db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import type { Database } from "bun:sqlite";
import {
  archiveIdentity,
  completeIdentity,
  ensureScratchDir,
  getIdentity,
  identityScratchDir,
  listIdentities,
  mintIdentity,
  sessionsForIdentity,
  setIdentityFields,
  uncompleteIdentity,
} from "./identities.ts";
import { identityLineage } from "./lineage-view.ts";

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function parseFlags(args: string[]): { flags: Record<string, string>; bools: Set<string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const bools = new Set<string>();
  const positional: string[] = [];
  for (const a of args) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq === -1) bools.add(a.slice(2));
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      positional.push(a);
    }
  }
  return { flags, bools, positional };
}

/** Legacy engine-facing shape: `ccs identity resolve --session <sid> [--json]`. Preserved. */
export async function identityResolveCommand(args: string[]): Promise<number> {
  return identityCommand(args);
}

export async function identityCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) return usage();
  ensureDataDir();
  // Lineage handled outside the shared db lifecycle — it opens its own catalogue + index.
  if (sub === "lineage") {
    const rest = args.slice(1);
    const searchIdx = rest.findIndex((a) => a === "--search");
    const query = searchIdx >= 0 ? rest[searchIdx + 1] : undefined;
    const key = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--search");
    return identityLineage(key, query);
  }
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    switch (sub) {
      case "list":       return doList(db, args.slice(1));
      case "ls":         return doList(db, args.slice(1));
      case "mint":       return doMint(db, args.slice(1));
      case "set":        return doSet(db, args.slice(1));
      case "complete":   return doLifecycle(db, args.slice(1), "complete");
      case "archive":    return doLifecycle(db, args.slice(1), "archive");
      case "uncomplete": return doLifecycle(db, args.slice(1), "uncomplete");
      case "path":       return doPath(db, args.slice(1));
      case "sessions":   return doSessions(db, args.slice(1));
      case "resolve":    return doResolve(db, args.slice(1));
      case "--help":
      case "-h":
      case "help":       return usage(0);
      default:           return doRead(db, sub, args.slice(1));
    }
  } finally {
    db.close();
  }
}

function usage(rc = 1): number {
  console.error("ccs identity: manage per-work-item identities.");
  console.error("");
  console.error("  ccs identity <key>                                 show identity (default)");
  console.error("  ccs identity list|ls [--cluster=…] [--role=…] [--grouping=…] [--kind=…]");
  console.error("                    [--completed|--archived]");
  console.error("  ccs identity mint <key> --cluster=c --role=r [--grouping=g]");
  console.error("  ccs identity set <key> --field=value [--other=value …]");
  console.error("                                                     meta.<k>=v merges JSON");
  console.error("                                                     --unset=field clears one");
  console.error("  ccs identity complete|archive|uncomplete <key>");
  console.error("  ccs identity path <key> [--new]");
  console.error("  ccs identity sessions <key>");
  console.error('  ccs identity lineage <key> [--search "<q>"]        bodies in succession + transcript search');
  console.error("  ccs identity resolve --session <sid>              (legacy)");
  return rc;
}

function doRead(db: Database, key: string, rest: string[]): number {
  const { bools } = parseFlags(rest);
  const id = getIdentity(db, key);
  if (!id) {
    console.error(`ccs identity: no identity '${key}'`);
    return 1;
  }
  if (bools.has("json")) {
    console.log(JSON.stringify(id, null, 2));
    return 0;
  }
  console.log(`identity ${id.identityKey}`);
  console.log(`  cluster:     ${id.cluster}`);
  console.log(`  role:        ${id.role} (${id.kind})`);
  if (id.groupingId) console.log(`  grouping:    ${id.groupingId}`);
  if (id.stage) console.log(`  stage:       ${id.stage}`);
  if (id.statusLine) console.log(`  status:      ${id.statusLine}`);
  if (id.completed) console.log(`  completed:   yes`);
  if (id.archived) console.log(`  archived:    yes`);
  if (id.parkedTaskId) console.log(`  parked:      ${id.parkedTaskId}`);
  if (Object.keys(id.meta).length > 0) {
    console.log(`  meta:`);
    for (const [k, v] of Object.entries(id.meta)) console.log(`    ${k} = ${JSON.stringify(v)}`);
  }
  if (Object.keys(id.attrs).length > 0) {
    console.log(`  attrs (${id.role}):`);
    for (const [k, v] of Object.entries(id.attrs)) console.log(`    ${k} = ${JSON.stringify(v)}`);
  }
  const sids = sessionsForIdentity(db, id.identityKey);
  console.log(
    `  sessions:    ${sids.length}${sids.length > 0 ? " — " + sids.map((s) => s.slice(0, 8)).join(", ") : ""}`,
  );
  return 0;
}

function doList(db: Database, rest: string[]): number {
  const { flags, bools } = parseFlags(rest);
  const kind = flags.kind as "fleet" | "core" | undefined;
  const rows = listIdentities(db, {
    cluster: flags.cluster,
    role: flags.role,
    groupingId: flags.grouping,
    kind: kind === "fleet" || kind === "core" ? kind : undefined,
    completed: bools.has("completed") ? true : undefined,
    archived: bools.has("archived") ? true : undefined,
  });
  if (bools.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("(no identities)");
    return 0;
  }
  for (const r of rows) {
    const lifecycle = r.archived ? "[A]" : r.completed ? "[C]" : "   ";
    const stage = r.stage ? ` · ${r.stage}` : "";
    console.log(`${lifecycle} ${r.identityKey}${stage}`);
  }
  return 0;
}

function doMint(db: Database, rest: string[]): number {
  const { flags, positional } = parseFlags(rest);
  const key = positional[0];
  if (!key) {
    console.error("ccs identity mint: missing <identity_key>");
    return 1;
  }
  const cluster = flags.cluster;
  const role = flags.role;
  if (!cluster || !role) {
    console.error("ccs identity mint: --cluster and --role are required");
    return 1;
  }
  const minted = mintIdentity(db, key, { cluster, role, groupingId: flags.grouping }, now());
  console.log(JSON.stringify({ status: minted ? "MINTED" : "EXISTS", identity_key: key }));
  return 0;
}

function doSet(db: Database, rest: string[]): number {
  const { flags, bools, positional } = parseFlags(rest);
  const key = positional[0];
  if (!key) {
    console.error("ccs identity set: missing <identity_key>");
    return 1;
  }
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (k === "unset") {
      patch[v] = null;
      continue;
    }
    if (/^-?\d+$/.test(v)) patch[k] = parseInt(v, 10);
    else if (v === "true") patch[k] = true;
    else if (v === "false") patch[k] = false;
    else patch[k] = v;
  }
  for (const b of bools) {
    if (b === "json") continue;
    patch[b] = null;
  }
  if (Object.keys(patch).length === 0) {
    console.error("ccs identity set: no fields to update");
    return 1;
  }
  try {
    const n = setIdentityFields(db, key, patch, now());
    console.log(JSON.stringify({ status: "OK", identity_key: key, fields_changed: n }));
    return 0;
  } catch (e) {
    console.error(`ccs identity set: ${(e as Error).message}`);
    return 1;
  }
}

function doLifecycle(db: Database, rest: string[], op: "complete" | "archive" | "uncomplete"): number {
  const { positional } = parseFlags(rest);
  const key = positional[0];
  if (!key) {
    console.error(`ccs identity ${op}: missing <identity_key>`);
    return 1;
  }
  if (!getIdentity(db, key)) {
    console.error(`ccs identity ${op}: no identity '${key}'`);
    return 1;
  }
  const t = now();
  if (op === "complete") completeIdentity(db, key, t);
  else if (op === "archive") archiveIdentity(db, key, t);
  else uncompleteIdentity(db, key, t);
  console.log(JSON.stringify({ status: "OK", identity_key: key, [op]: true }));
  return 0;
}

function doPath(db: Database, rest: string[]): number {
  const { bools, positional } = parseFlags(rest);
  const key = positional[0];
  if (!key) {
    console.error("ccs identity path: missing <identity_key>");
    return 1;
  }
  const exists = !!getIdentity(db, key);
  const dir = bools.has("new") ? ensureScratchDir(key) : identityScratchDir(key);
  if (bools.has("json")) {
    console.log(JSON.stringify({ status: "OK", identity_key: key, path: dir, identity_exists: exists }));
  } else {
    console.log(dir);
    if (!exists) console.error(`(note: no identity '${key}' — path is derived only)`);
  }
  return 0;
}

function doSessions(db: Database, rest: string[]): number {
  const { bools, positional } = parseFlags(rest);
  const key = positional[0];
  if (!key) {
    console.error("ccs identity sessions: missing <identity_key>");
    return 1;
  }
  const sids = sessionsForIdentity(db, key);
  if (bools.has("json")) {
    console.log(JSON.stringify({ identity_key: key, sessions: sids }));
  } else {
    for (const s of sids) console.log(s);
  }
  return 0;
}

/** Legacy: `ccs identity resolve --session <sid>` — returns the derived identity_key + facts. */
function doResolve(db: Database, args: string[]): number {
  const sIdx = args.indexOf("--session");
  const sessionId = sIdx >= 0 ? args[sIdx + 1] : null;
  if (!sessionId) {
    console.error("ccs identity resolve: --session <sid> required");
    return 1;
  }
  const row = getRow(db, sessionId);
  if (!row) {
    console.log(
      JSON.stringify({
        schema: 1,
        sessionId,
        key: null,
        role: null,
        cluster: null,
        workUnitId: null,
        gusWork: null,
        prRepo: null,
        prNumber: null,
        updatedAt: null,
      }),
    );
    return 0;
  }
  // Compute both the LEGACY key (from db.ts identityKeyOf, backwards compat) and the NEW
  // structured key. Emit legacy in the `key` field for now; engines migrate in step 9.
  const legacyKey = row.key;
  const newKey = deriveIdentityKey({
    cluster: row.cluster,
    role: row.role,
    prRepo: row.prRepo,
    prNumber: row.prNumber,
    gusWork: row.gusWork,
    workUnitId: row.workUnitId,
  });
  console.log(
    JSON.stringify({
      schema: 1,
      sessionId,
      key: legacyKey,
      identity_key: newKey,
      role: row.role,
      cluster: row.cluster,
      workUnitId: row.workUnitId,
      gusWork: row.gusWork,
      prRepo: row.prRepo,
      prNumber: row.prNumber,
      updatedAt: row.updatedAt,
    }),
  );
  return 0;
}
