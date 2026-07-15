/**
 * ADR-0089 step 4: `ccs grouping <verb>` CLI. Reads / writes the `groupings` table (DB-backed;
 * replaces the pre-refactor JSON-file store). Migration of ~/.ccs/clusters/<c>/cluster/
 * groupings.json into the table happens on ccs boot via groupings-migrate.ts.
 *
 *   ccs grouping <id>                              read one
 *   ccs grouping list [--cluster=c] [--role=r] [--closed|--open]
 *   ccs grouping upsert <id> --cluster=c --role=r [--label=… --url=… --short_name=… --context=@file]
 *   ccs grouping set <id> --label=… --url=… …
 *   ccs grouping unset <id> --label
 *   ccs grouping note-add <id> "text"
 *   ccs grouping close|reopen <id>
 *   ccs grouping delete <id>
 */
import { openCatalogue } from "../catalogue/db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  appendNote,
  deleteGrouping,
  getGrouping,
  listGroupings,
  setClosed,
  upsertGrouping,
} from "./groupings-db.ts";

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Parse `--key=value` flags + boolean flags + positional args out of argv. */
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

/** Resolve `@filename` to file contents; passthrough otherwise. Used for --context=@notes.md */
function resolveFileRef(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.startsWith("@")) return readFileSync(value.slice(1), "utf8");
  return value;
}

export function groupingCommand(args: string[]): number {
  const sub = args[0];
  if (!sub) return usage();
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    switch (sub) {
      case "list":       return doList(db, args.slice(1));
      case "upsert":     return doUpsert(db, args.slice(1));
      case "set":        return doSet(db, args.slice(1));
      case "unset":      return doUnset(db, args.slice(1));
      case "note-add":   return doNoteAdd(db, args.slice(1));
      case "close":      return doClose(db, args.slice(1), true);
      case "reopen":     return doClose(db, args.slice(1), false);
      case "delete":     return doDelete(db, args.slice(1));
      case "--help":
      case "-h":
      case "help":       return usage(0);
      default:           return doRead(db, sub, args.slice(1));  // bare id → read
    }
  } finally {
    db.close();
  }
}

function usage(rc = 1): number {
  console.error("ccs grouping: manage cluster groupings (epics / sprints / whatever the role calls them).");
  console.error("");
  console.error("  ccs grouping <id>                              show one grouping");
  console.error("  ccs grouping list [--cluster=c] [--role=r] [--closed|--open]");
  console.error("  ccs grouping upsert <id> --cluster=c --role=r [--label=… --url=… --short_name=… --context=@file]");
  console.error("  ccs grouping set <id> --label=… --url=…        update fields");
  console.error("  ccs grouping unset <id> --label                clear one field");
  console.error("  ccs grouping note-add <id> \"note text\"         append project memory");
  console.error("  ccs grouping close|reopen <id>                 lifecycle");
  console.error("  ccs grouping delete <id>                       remove");
  return rc;
}

function doRead(db: Database, id: string, rest: string[]): number {
  const { bools } = parseFlags(rest);
  const g = getGrouping(db, id);
  if (!g) {
    console.error(`ccs grouping: no grouping '${id}'`);
    return 1;
  }
  if (bools.has("json")) {
    console.log(JSON.stringify(g, null, 2));
    return 0;
  }
  console.log(`grouping ${g.groupingId}`);
  console.log(`  cluster:    ${g.cluster}`);
  console.log(`  role:       ${g.role}`);
  console.log(`  label:      ${g.label ?? "-"}`);
  console.log(`  url:        ${g.url ?? "-"}`);
  console.log(`  short_name: ${g.shortName ?? "-"}`);
  console.log(`  closed:     ${g.closed}`);
  console.log(`  updated_at: ${g.updatedAt ?? "-"}`);
  console.log(`  notes:      ${g.notes.length}`);
  for (const n of g.notes) console.log(`    - ${n}`);
  if (g.context) console.log(`  context:    (${g.context.length} chars)`);
  return 0;
}

function doList(db: Database, rest: string[]): number {
  const { flags, bools } = parseFlags(rest);
  const rows = listGroupings(db, {
    cluster: flags.cluster,
    role: flags.role,
    closed: bools.has("closed") ? true : bools.has("open") ? false : undefined,
  });
  if (bools.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("(no groupings)");
    return 0;
  }
  for (const g of rows) {
    const mark = g.closed ? "[closed]" : "        ";
    console.log(`${mark} ${g.groupingId}  ${g.shortName ?? g.label ?? "-"}  (${g.cluster}/${g.role})`);
  }
  return 0;
}

function doUpsert(db: Database, rest: string[]): number {
  const { flags, positional } = parseFlags(rest);
  const id = positional[0];
  if (!id) {
    console.error("ccs grouping upsert: missing <id>");
    return 1;
  }
  const existing = getGrouping(db, id);
  if (!existing && (!flags.cluster || !flags.role)) {
    console.error("ccs grouping upsert: --cluster and --role are required for a new grouping");
    return 1;
  }
  upsertGrouping(
    db,
    id,
    {
      cluster: flags.cluster ?? existing?.cluster ?? "",
      role: flags.role ?? existing?.role ?? "",
      label: flags.label,
      url: flags.url,
      shortName: flags.short_name,
      context: resolveFileRef(flags.context),
    },
    now(),
  );
  console.log(JSON.stringify({ status: "OK", groupingId: id }));
  return 0;
}

function doSet(db: Database, rest: string[]): number {
  const { flags, positional } = parseFlags(rest);
  const id = positional[0];
  if (!id) {
    console.error("ccs grouping set: missing <id>");
    return 1;
  }
  const existing = getGrouping(db, id);
  if (!existing) {
    console.error(`ccs grouping set: no grouping '${id}' — use 'upsert' to create`);
    return 1;
  }
  upsertGrouping(
    db,
    id,
    {
      cluster: flags.cluster ?? existing.cluster,
      role: flags.role ?? existing.role,
      label: flags.label,
      url: flags.url,
      shortName: flags.short_name,
      context: resolveFileRef(flags.context),
    },
    now(),
  );
  console.log(JSON.stringify({ status: "OK", groupingId: id }));
  return 0;
}

function doUnset(db: Database, rest: string[]): number {
  const { flags, bools, positional } = parseFlags(rest);
  const id = positional[0];
  if (!id) {
    console.error("ccs grouping unset: missing <id>");
    return 1;
  }
  const existing = getGrouping(db, id);
  if (!existing) {
    console.error(`ccs grouping unset: no grouping '${id}'`);
    return 1;
  }
  const targets = new Set([...Object.keys(flags), ...bools]);
  upsertGrouping(
    db,
    id,
    {
      cluster: existing.cluster,
      role: existing.role,
      label: targets.has("label") ? null : undefined,
      url: targets.has("url") ? null : undefined,
      shortName: targets.has("short_name") ? null : undefined,
      context: targets.has("context") ? null : undefined,
    },
    now(),
  );
  console.log(JSON.stringify({ status: "OK", groupingId: id }));
  return 0;
}

function doNoteAdd(db: Database, rest: string[]): number {
  const { positional } = parseFlags(rest);
  const id = positional[0];
  const note = positional.slice(1).join(" ");
  if (!id || !note) {
    console.error('ccs grouping note-add: usage: ccs grouping note-add <id> "note text"');
    return 1;
  }
  const existing = getGrouping(db, id);
  if (!existing) {
    console.error(`ccs grouping note-add: no grouping '${id}' — upsert it first`);
    return 1;
  }
  appendNote(db, id, existing.cluster, existing.role, note, now());
  console.log(JSON.stringify({ status: "OK", groupingId: id }));
  return 0;
}

function doClose(db: Database, rest: string[], closed: boolean): number {
  const { positional } = parseFlags(rest);
  const id = positional[0];
  if (!id) {
    console.error(`ccs grouping ${closed ? "close" : "reopen"}: missing <id>`);
    return 1;
  }
  if (!getGrouping(db, id)) {
    console.error(`ccs grouping: no grouping '${id}'`);
    return 1;
  }
  setClosed(db, id, closed, now());
  console.log(JSON.stringify({ status: "OK", groupingId: id, closed }));
  return 0;
}

function doDelete(db: Database, rest: string[]): number {
  const { positional } = parseFlags(rest);
  const id = positional[0];
  if (!id) {
    console.error("ccs grouping delete: missing <id>");
    return 1;
  }
  if (!getGrouping(db, id)) {
    console.error(`ccs grouping delete: no grouping '${id}'`);
    return 1;
  }
  deleteGrouping(db, id);
  console.log(JSON.stringify({ status: "OK", groupingId: id, deleted: true }));
  return 0;
}
