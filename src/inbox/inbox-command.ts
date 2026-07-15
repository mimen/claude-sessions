/**
 * ADR-0089 step 5: DB-backed `ccs inbox` CLI. Messages live in the `inboxes` table keyed by
 * identity_key. Replaces the file-based inbox at ~/.ccs/clusters/<c>/identities/<r>/inbox.
 *
 *   ccs inbox send    --to=<identity_key> [--from=<role>] --message="…"
 *   ccs inbox pending <identity_key>              List pending messages (JSON)
 *   ccs inbox drain   <identity_key>              Drain (atomic; returns messages)
 *   ccs inbox history <identity_key>              All messages (pending + drained)
 *   ccs inbox bump    <identity_key> [--note "…"] Wake the identity's live session via cmux
 *
 * Legacy addressing (pre-refactor engine callers) still accepted:
 *   --cluster <c> --role <r> --work-unit <w>
 * Ccs synthesizes an identity_key from the tuple. This is a courtesy for step 5; engine
 * scripts migrate to explicit identity_keys in step 9.
 */
import { openCatalogue, getRow, deriveIdentityKey } from "../catalogue/db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { drainForIdentity, historyForIdentity, pendingForIdentity, sendMessage } from "./inbox-db.ts";
import { liveBridge } from "../cmux/live.ts";
import { planBump, wakeSurface } from "./bump.ts";
import type { Database } from "bun:sqlite";

function stamp(): string {
  return new Date().toISOString();
}

/** Legacy-style `--flag value` reader (adjacent value). */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

/** New-style `--flag=value` reader (equals sign). */
function eqFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const a of args) if (a.startsWith(prefix)) return a.slice(prefix.length);
  return undefined;
}

function anyFlag(args: string[], name: string): string | undefined {
  return eqFlag(args, name) ?? flag(args, `--${name}`);
}

/**
 * Turn `--work-unit owner_repo-12345` or `--work-unit owner/repo#12345` into PR components,
 * or a `W-…` string into a gus_work value, so deriveIdentityKey can build the canonical key.
 */
function parseWorkUnit(wu?: string): { prRepo?: string; prNumber?: number; gusWork?: string } {
  if (!wu) return {};
  const flat = wu.match(/^([a-z0-9._-]+)_([a-z0-9._-]+)-(\d+)$/i);
  if (flat) return { prRepo: `${flat[1]}/${flat[2]}`, prNumber: parseInt(flat[3]!, 10) };
  const slash = wu.match(/^([a-z0-9._-]+\/[a-z0-9._-]+)#(\d+)$/i);
  if (slash) return { prRepo: slash[1], prNumber: parseInt(slash[2]!, 10) };
  if (wu.startsWith("W-")) return { gusWork: wu };
  return {};
}

/**
 * Resolve the addressed identity_key. Order:
 *   1. explicit positional `<identity_key>` (bare id form)
 *   2. `--to=<key>` or `--to <key>`
 *   3. legacy tuple `--cluster/--role/--work-unit` synthesized via deriveIdentityKey
 */
function resolveIdentityKey(args: string[]): string | null {
  // Explicit --to
  const to = anyFlag(args, "to");
  if (to) return to;
  // Bare positional (first non-flag non-flag-value)
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    if (a.startsWith("--")) {
      if (!a.includes("=")) i++; // skip its adjacent value
      continue;
    }
    // Skip subcommand tokens (send/pending/drain/history/bump) — the caller already sliced
    // args past the subcommand, so a bare positional here IS the key.
    return a;
  }
  // Legacy tuple
  const role = anyFlag(args, "role");
  if (!role) return null;
  return deriveIdentityKey({
    cluster: anyFlag(args, "cluster") ?? undefined,
    role,
    ...parseWorkUnit(anyFlag(args, "work-unit")),
  });
}

export function inboxCommand(args: string[]): number {
  const sub = args[0];
  if (!sub) return usage();
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    switch (sub) {
      case "send":    return doSend(db, args.slice(1));
      case "pending": return doPending(db, args.slice(1));
      case "drain":   return doDrain(db, args.slice(1));
      case "history": return doHistory(db, args.slice(1));
      case "bump":    return doBump(db, args.slice(1));
      case "--help":
      case "-h":
      case "help":    return usage(0);
      default:
        console.error(`ccs inbox: unknown subcommand "${sub}"`);
        return usage();
    }
  } finally {
    db.close();
  }
}

function usage(rc = 1): number {
  console.error("ccs inbox: per-identity durable messaging.");
  console.error("");
  console.error("  ccs inbox send    --to=<key> [--from=<role>] --message=\"…\"");
  console.error("  ccs inbox pending <key>                       list pending");
  console.error("  ccs inbox drain   <key>                       drain (atomic)");
  console.error("  ccs inbox history <key>                       all messages");
  console.error("  ccs inbox bump    <key> [--note=\"…\"]           wake live session");
  console.error("");
  console.error("  Legacy addressing (still accepted):");
  console.error("    --cluster c --role r --work-unit w");
  return rc;
}

function doSend(db: Database, args: string[]): number {
  const key = resolveIdentityKey(args);
  if (!key) {
    console.error("ccs inbox send: need --to <identity_key> or --cluster/--role/--work-unit");
    return 1;
  }
  const message = anyFlag(args, "message");
  const from = anyFlag(args, "from") ?? null;
  if (!message) {
    console.error("ccs inbox send: --message required");
    return 1;
  }
  const id = sendMessage(db, key, message, from, stamp());
  console.log(JSON.stringify({ status: "OK", inbox_id: id, identity_key: key }));
  return 0;
}

function doPending(db: Database, args: string[]): number {
  const key = resolveIdentityKey(args);
  if (!key) {
    console.error("ccs inbox pending: need <identity_key> or --cluster/--role/--work-unit");
    return 1;
  }
  const rows = pendingForIdentity(db, key);
  console.log(JSON.stringify({ status: "OK", count: rows.length, pending: rows }));
  return 0;
}

function doDrain(db: Database, args: string[]): number {
  const key = resolveIdentityKey(args);
  if (!key) {
    console.error("ccs inbox drain: need <identity_key> or --cluster/--role/--work-unit");
    return 1;
  }
  const rows = drainForIdentity(db, key, stamp());
  console.log(
    JSON.stringify({
      status: "OK",
      count: rows.length,
      messages: rows.map((r) => ({ inbox_id: r.inboxId, sender: r.fromRole, body: r.message })),
    }),
  );
  return 0;
}

function doHistory(db: Database, args: string[]): number {
  const key = resolveIdentityKey(args);
  if (!key) {
    console.error("ccs inbox history: need <identity_key>");
    return 1;
  }
  const rows = historyForIdentity(db, key);
  console.log(JSON.stringify({ status: "OK", count: rows.length, messages: rows }));
  return 0;
}

function doBump(db: Database, args: string[]): number {
  const key = resolveIdentityKey(args);
  if (!key) {
    console.error("ccs inbox bump: need <identity_key>");
    return 1;
  }
  const note = anyFlag(args, "note") ?? "";
  const sids = db.query(
    "SELECT session_id FROM catalogue WHERE identity_key = $k",
  ).all({ $k: key }) as { session_id: string }[];
  if (sids.length === 0) {
    console.error(`ccs inbox bump: no sessions attached to identity ${key}`);
    return 1;
  }
  const bridge = liveBridge();
  if (!bridge.readable) {
    console.log(JSON.stringify({ status: "no-liveness-signal", identity_key: key, woke: 0 }));
    return 1;
  }
  let woke = 0;
  for (const { session_id } of sids) {
    const row = getRow(db, session_id);
    if (!row) continue;
    const plan = planBump(bridge, row.resumeId ?? session_id);
    if (plan.wake && plan.surfaceRef && wakeSurface(plan.surfaceRef, note || `[ccs] new inbox message`)) {
      woke++;
    }
  }
  console.log(JSON.stringify({ status: woke > 0 ? "OK" : "no-live-surface", identity_key: key, woke }));
  return woke > 0 ? 0 : 1;
}
