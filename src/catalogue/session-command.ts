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
 *   ccs session new [flags]                         delegates to legacy new-session
 *   ccs session bump <id> [--note "…"]              wake a specific session
 *
 * Old top-level commands (rename, mark, key, parent, project, role, gus-work, epic, status,
 * name, stage, meta, meta-set, set-cluster, system, new-session, new, bump-session) still work
 * — they're used by hooks/skills and get swept in step 10. This noun is the new PREFERRED
 * surface; the old ones become deprecation candidates once the sweep lands.
 */
import { openCatalogue, getRow } from "./db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import type { Database } from "bun:sqlite";
import { getIdentity } from "./identities.ts";
import { rename, mark, parent, setClusterCmd, setParked as _sp } from "./commands.ts";
import { newSession } from "../resume/new-session.ts";

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
  console.error("  ccs session <id|.>                              show one session");
  console.error("  ccs session list                                (alias for `ccs ls`)");
  console.error("  ccs session set <id> --identity=<key> [--title=\"…\"] [--parent=<id>] [--parked=<task>]");
  console.error("  ccs session unset <id> --identity|--title|--parent|--parked");
  console.error("  ccs session title <id> \"text\"                   set title + sync cmux tab");
  console.error("  ccs session complete|archive|uncomplete|unarchive <id>");
  console.error("  ccs session new [flags]                         mint id + launch claude");
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
    if (!row) {
      console.error(`ccs session: no session '${sid}'`);
      return 1;
    }
    // Session row also carries the FK to its identity (nullable). Join it if present.
    const identityKey = (db
      .query("SELECT identity_key FROM catalogue WHERE session_id = $sid")
      .get({ $sid: sid }) as { identity_key: string | null } | null)?.identity_key ?? null;
    const identity = identityKey ? getIdentity(db, identityKey) : null;

    if (bools.has("json")) {
      console.log(JSON.stringify({ session: row, identity_key: identityKey, identity }, null, 2));
      return 0;
    }
    console.log(`session ${sid}`);
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
  } finally {
    db.close();
  }
}

function doList(_rest: string[]): number {
  console.error("ccs session list: run `ccs ls` for the full session browser.");
  return 1;
}

function doSet(rest: string[]): number {
  const { flags, positional } = parseFlags(rest);
  const sid = resolveSessionId(positional[0]);
  if (!sid) {
    console.error("ccs session set: missing <session-id>");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  const changes: string[] = [];
  try {
    if (flags.identity !== undefined) {
      // Attach the session to an identity.
      db.query("UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $sid")
        .run({ $k: flags.identity, $now: now(), $sid: sid });
      changes.push(`identity=${flags.identity}`);
    }
    if (flags.title !== undefined) {
      const rc = rename(sid, flags.title);
      if (rc !== 0) return rc;
      changes.push(`title=${flags.title}`);
    }
    if (flags.parent !== undefined) {
      const rc = parent(sid, flags.parent, []);
      if (rc !== 0) return rc;
      changes.push(`parent=${flags.parent}`);
    }
    if (flags.parked !== undefined) {
      db.query("UPDATE catalogue SET parked_task_id = $p, updated_at = $now WHERE session_id = $sid")
        .run({ $p: flags.parked, $now: now(), $sid: sid });
      changes.push(`parked=${flags.parked}`);
    }
    if (flags.cluster !== undefined) {
      // Cluster on the session is legacy but still supported through this shim while sessions
      // carry it; step 12 removes the column after every caller migrates.
      const rc = setClusterCmd(sid, flags.cluster, []);
      if (rc !== 0) return rc;
      changes.push(`cluster=${flags.cluster}`);
    }
    if (changes.length === 0) {
      console.error("ccs session set: no fields to update (use --identity=, --title=, --parent=, --parked=)");
      return 1;
    }
    console.log(JSON.stringify({ status: "OK", session_id: sid, changes }));
    return 0;
  } finally {
    db.close();
  }
}

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
      parent(sid, undefined, ["--off"]);
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
