/**
 * ADR-0089 step 7: `ccs session <verb>` — the per-run session CLI surface. Sessions are the
 * ephemeral instances; identities carry the durable state. This noun exposes the small set of
 * operations that legitimately live per-session:
 *
 *   ccs session <id|.>                              read one session's row + linked identity
 *   ccs session list                                (defers to `ccs ls`; kept as noun-shape alias)
 *   ccs session set <id> --identity=<key> [--title="…"] [--parent=<id>] [--parked=<task>]
 *   ccs session unset <id> --identity | --title | --parent | --parked
 *   ccs session title <id> "text"                   same as --title but also cmux tab sync
 *   ccs session complete <id> | archive <id>        session lifecycle (distinct from identity)
 *   ccs session new <--top-level|--child-of <uuid|.>> [flags]  delegates to legacy new-session
 *   ccs session bump <id> [--note "…"]              wake a specific session
 *
 * Old top-level commands (rename, mark, key, parent, project, role, gus-work, epic, status,
 * name, stage, meta, meta-set, set-cluster, system, new-session, new, bump-session) still work
 * — they're used by hooks/skills and get swept in step 10. This noun is the new PREFERRED
 * surface; the old ones become deprecation candidates once the sweep lands.
 */
import { openCatalogue, getRow } from "./db.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { existsSync } from "node:fs";
import { openIndex } from "../index/schema.ts";
import { sessionById } from "../index/index.ts";
import type { Database } from "bun:sqlite";
import { getIdentity } from "./identities.ts";
import { rename, mark } from "./commands.ts";
import { newSession } from "../resume/new-session.ts";
import { pushCmuxRename } from "../cmux/liveness.ts";

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

/** Resolve `.` (current session env var) or a bare id. */
function resolveSessionId(sIdOrDot: string | undefined): string | null {
  if (!sIdOrDot) return null;
  if (sIdOrDot !== ".") return sIdOrDot;
  const env = process.env.CLAUDE_CODE_SESSION_ID;
  return env ?? null;
}

export async function sessionCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub) return usage();
  switch (sub) {
    case "list":     return doList(args.slice(1));
    case "set":      return doSet(args.slice(1));
    case "adopt":    return doAdopt(args.slice(1));
    case "unset":    return doUnset(args.slice(1));
    case "title":    return doTitle(args.slice(1));
    case "complete": return doLifecycle(args.slice(1), ["--completed"]);
    case "archive":  return doLifecycle(args.slice(1), ["--archived"]);
    case "uncomplete": return doLifecycle(args.slice(1), ["--completed", "--off"]);
    case "unarchive":  return doLifecycle(args.slice(1), ["--archived", "--off"]);
    case "new":      return newSession(args.slice(1));
    case "bump":     return await doBump(args.slice(1));
    case "--help":
    case "-h":
    case "help":     return usage(0);
    default:         return doRead(sub, args.slice(1));
  }
}

function usage(rc = 1): number {
  console.error("ccs session: per-session operations (per-run state; use ccs identity for durable state).");
  console.error("");
  console.error("  ccs session <id|.>                              show one session (catalogued or indexed-unattached)");
  console.error("  ccs session list                                (alias for `ccs ls`)");
  console.error("  ccs session adopt <id> --identity=<key>         attach an indexed transcript to a pre-existing identity");
  console.error("  ccs session set <id> --identity=<key> [--title=\"…\"] [--parent=<id>] [--parked=<task>]  (catalogued only)");
  console.error("  ccs session unset <id> --identity|--title|--parent|--parked");
  console.error("  ccs session title <id> \"text\"                   set title + sync cmux tab");
  console.error("  ccs session complete|archive|uncomplete|unarchive <id>");
  console.error("  ccs session new <--top-level|--child-of <uuid|.>> [flags]  mint id + launch claude");
  console.error("    --identity=<key> requires matching --cluster=<c> and --role=<r>; legacy PR/GUS birth remains available");
  console.error("  ccs session bump <id> [--note=\"…\"]              wake this session's cmux tab");
  return rc;
}

function doRead(idArg: string, rest: string[]): number {
  const { bools } = parseFlags(rest);
  const sid = resolveSessionId(idArg);
  if (!sid) {
    console.error("ccs session: no session id (bare id, '.', or $CLAUDE_CODE_SESSION_ID)");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const row = getRow(db, sid);
    if (row) {
      const identityKey = (db
        .query("SELECT identity_key FROM catalogue WHERE session_id = $sid")
        .get({ $sid: sid }) as { identity_key: string | null } | null)?.identity_key ?? null;
      const identity = identityKey ? getIdentity(db, identityKey) : null;
      if (bools.has("json")) {
        console.log(JSON.stringify({ state: "catalogued", session: row, identity_key: identityKey, identity }, null, 2));
        return 0;
      }
      console.log(`session ${sid}`);
      console.log(`  state:        catalogued`);
      console.log(`  title:        ${row.customTitle ?? "-"}`);
      console.log(`  parent:       ${row.parentSessionId ?? "-"}`);
      console.log(`  parked:       ${row.parkedTaskId ?? "-"}`);
      console.log(`  identity_key: ${identityKey ?? "(loose)"}`);
      if (identity) {
        console.log(`  → identity:   ${identity.role}@${identity.cluster} ${identity.kind}`);
        if (identity.stage) console.log(`  → stage:      ${identity.stage}`);
        if (identity.statusLine) console.log(`  → status:     ${identity.statusLine}`);
      }
      return 0;
    }
  } finally {
    db.close();
  }

  const indexed = indexedSession(sid);
  if (!indexed) {
    console.error(`ccs session: no session '${sid}' (not catalogued or indexed; run \`ccs reindex\` if a transcript is expected)`);
    return 1;
  }
  const payload = {
    state: "indexed-unattached",
    session: indexed,
    adoption_hint: `ccs session adopt ${sid} --identity=<existing-identity-key>`,
  };
  if (bools.has("json")) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  console.log(`session ${sid}`);
  console.log("  state:        indexed-unattached");
  console.log(`  path:         ${indexed.path}`);
  console.log(`  cwd:          ${indexed.cwd ?? "-"}`);
  console.log(`  project:      ${indexed.projectName}`);
  console.log(`  resume_id:    ${indexed.resumeId || "-"}`);
  if ((indexed.shadowPaths?.length ?? 0) > 0) console.log(`  duplicates:   ${indexed.shadowPaths?.join(", ")}`);
  console.log(`  adopt:        ${payload.adoption_hint}`);
  return 0;
}

function indexedSession(sessionId: string) {
  if (!existsSync(DB_PATH())) return null;
  const index = openIndex(DB_PATH());
  try {
    return sessionById(index, sessionId);
  } finally {
    index.close();
  }
}

function doList(_rest: string[]): number {
  console.error("ccs session list: run `ccs ls` for the full session browser.");
  return 1;
}

function doAdopt(rest: string[]): number {
  const { flags, positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid || !flags.identity) {
    console.error("usage: ccs session adopt <id> --identity=<existing-identity-key>");
    return 1;
  }
  const indexed = indexedSession(sid);
  if (!indexed) {
    console.error(`ccs session adopt: '${sid}' is not indexed; run \`ccs reindex\` first`);
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (getRow(db, sid)) {
        console.error(`ccs session adopt: '${sid}' already has catalogue metadata`);
        db.exec("ROLLBACK");
        return 1;
      }
      if (!getIdentity(db, flags.identity)) {
        console.error(`ccs session adopt: identity '${flags.identity}' does not exist — mint it first with \`ccs identity mint\``);
        db.exec("ROLLBACK");
        return 1;
      }
      db.query(
        `INSERT INTO catalogue (session_id, identity_key, resume_id, updated_at)
         VALUES ($sid, $identity, $resume, $now)`,
      ).run({ $sid: sid, $identity: flags.identity, $resume: indexed.resumeId || null, $now: now() });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  console.log(JSON.stringify({ status: "OK", state: "catalogued", session_id: sid, identity: flags.identity }));
  return 0;
}

function doSet(rest: string[]): number {
  const { flags, positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid) {
    console.error("ccs session set: missing <session-id>");
    return 1;
  }
  if (flags.cluster !== undefined) {
    console.error("ccs session set: --cluster is retired; cluster belongs to the attached identity");
    return 1;
  }
  const fields = ["identity", "title", "parent", "parked"].filter((field) => flags[field] !== undefined);
  if (fields.length === 0) {
    console.error("ccs session set: no fields to update (use --identity=, --title=, --parent=, --parked=)");
    return 1;
  }
  if (flags.title !== undefined && !flags.title.trim()) {
    console.error("ccs session set: --title must not be empty");
    return 1;
  }
  const parentId = flags.parent === "self"
    ? process.env.CLAUDE_CODE_SESSION_ID ?? null
    : resolveSessionId(flags.parent);
  if (flags.parent !== undefined) {
    if (!parentId) {
      console.error("ccs session set: no current session id for --parent=.|self");
      return 1;
    }
    if (parentId === sid) {
      console.error("A session can't be its own parent.");
      return 1;
    }
    if (!SESSION_ID_RE.test(parentId)) {
      console.error(`Not a session id: ${parentId} (expected a UUID). Nothing set.`);
      return 1;
    }
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = getRow(db, sid);
      if (!current) {
        console.error(`ccs session set: '${sid}' is indexed but unattached or unknown; use \`ccs session adopt ${sid} --identity=<key>\` first`);
        db.exec("ROLLBACK");
        return 1;
      }
      if (flags.identity !== undefined) {
        const identity = getIdentity(db, flags.identity);
        if (!identity) {
          console.error(`ccs session set: identity '${flags.identity}' does not exist — mint it first with \`ccs identity mint\``);
          db.exec("ROLLBACK");
          return 1;
        }
        if (current.identityKey && current.cluster && current.role &&
          (current.cluster !== identity.cluster || current.role !== identity.role)) {
          console.error(`ccs session set: identity '${flags.identity}' is ${identity.role}@${identity.cluster}, but session '${sid}' is ${current.role}@${current.cluster}`);
          db.exec("ROLLBACK");
          return 1;
        }
      }
      const assignments: string[] = [];
      const params: Record<string, string | null> = { $sid: sid, $now: now() };
      if (flags.identity !== undefined) { assignments.push("identity_key = $identity"); params.$identity = flags.identity; }
      if (flags.title !== undefined) { assignments.push("custom_title = $title"); params.$title = flags.title.trim(); }
      if (flags.parent !== undefined) { assignments.push("parent_session_id = $parent"); params.$parent = parentId; }
      if (flags.parked !== undefined) { assignments.push("parked_task_id = $parked"); params.$parked = flags.parked; }
      db.query(`UPDATE catalogue SET ${assignments.join(", ")}, updated_at = $now WHERE session_id = $sid`).run(params);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
  if (flags.title !== undefined) pushCmuxRename(sid, flags.title.trim());
  console.log(JSON.stringify({ status: "OK", session_id: sid, changes: fields.map((field) => `${field}=${flags[field]}`) }));
  return 0;
}

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function doUnset(rest: string[]): number {
  const { flags, bools, positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid) {
    console.error("ccs session unset: missing <session-id>");
    return 1;
  }
  const targets = new Set([...Object.keys(flags), ...bools].filter((k) => k !== "json"));
  if (targets.size === 0) {
    console.error("ccs session unset: nothing to clear (use --identity | --title | --parent | --parked)");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  const cleared: string[] = [];
  try {
    if (!getRow(db, sid)) {
      console.error(`ccs session unset: '${sid}' is not catalogued; use \`ccs session adopt ${sid} --identity=<key>\` first`);
      return 1;
    }
    if (targets.has("identity")) {
      db.query("UPDATE catalogue SET identity_key = NULL, updated_at = $now WHERE session_id = $sid")
        .run({ $now: now(), $sid: sid });
      cleared.push("identity");
    }
    if (targets.has("title")) {
      db.query("UPDATE catalogue SET custom_title = NULL, updated_at = $now WHERE session_id = $sid")
        .run({ $now: now(), $sid: sid });
      cleared.push("title");
    }
    if (targets.has("parent")) {
      db.query("UPDATE catalogue SET parent_session_id = NULL, updated_at = $now WHERE session_id = $sid")
        .run({ $now: now(), $sid: sid });
      cleared.push("parent");
    }
    if (targets.has("parked")) {
      db.query("UPDATE catalogue SET parked_task_id = NULL, updated_at = $now WHERE session_id = $sid")
        .run({ $now: now(), $sid: sid });
      cleared.push("parked");
    }
    console.log(JSON.stringify({ status: "OK", session_id: sid, cleared }));
    return 0;
  } finally {
    db.close();
  }
}

function doTitle(rest: string[]): number {
  const { positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid) {
    console.error("ccs session title: missing <session-id>");
    return 1;
  }
  const text = positional.slice(1).join(" ");
  if (!text.trim()) {
    console.error('ccs session title: usage: ccs session title <id> "text"');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    if (!getRow(db, sid)) {
      console.error(`ccs session title: '${sid}' is not catalogued; use \`ccs session adopt ${sid} --identity=<key>\` first`);
      return 1;
    }
  } finally {
    db.close();
  }
  return rename(sid, text);
}

function doLifecycle(rest: string[], flags: string[]): number {
  const { positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid) {
    console.error("ccs session: missing <session-id>");
    return 1;
  }
  return mark(sid, flags);
}

async function doBump(rest: string[]): Promise<number> {
  const { flags, positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid) {
    console.error("ccs session bump: missing <session-id>");
    return 1;
  }
  const { bumpSessionCommand } = await import("../inbox/bump-session-command.ts");
  const relayed = [sid];
  if (flags.note !== undefined) relayed.push("--note", flags.note);
  return bumpSessionCommand(relayed);
}
