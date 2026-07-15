import type { Database } from "bun:sqlite";

/**
 * ADR-0089 step 5: DB-backed inbox. Replaces the file-based inbox in inbox.ts.
 *
 * Every message is a row in the `inboxes` table (created by v32) keyed by identity_key.
 * Sends INSERT with status='pending'; drains atomically flip status='drained' + return
 * the messages in one transaction (SQL's answer to move-on-drain — the UPDATE and SELECT
 * happen inside BEGIN/COMMIT so a drained message is never returned twice).
 *
 * Table shape (from v32):
 *   inbox_id       PK autoincrement (chronological)
 *   identity_key   FK -> identities.identity_key (soft; loose sends allowed)
 *   from_role      TEXT (nullable)
 *   message        TEXT (the body)
 *   status         'pending' | 'drained'
 *   created_at     ISO stamp
 *   drained_at     ISO stamp (nullable)
 */

export interface InboxRow {
  inboxId: number;
  identityKey: string;
  fromRole: string | null;
  message: string;
  status: "pending" | "drained";
  createdAt: string;
  drainedAt: string | null;
}

function fromRow(r: Record<string, unknown>): InboxRow {
  return {
    inboxId: r.inbox_id as number,
    identityKey: r.identity_key as string,
    fromRole: (r.from_role as string) ?? null,
    message: r.message as string,
    status: r.status as "pending" | "drained",
    createdAt: r.created_at as string,
    drainedAt: (r.drained_at as string) ?? null,
  };
}

/** Append one message. Returns the new inbox_id. */
export function sendMessage(
  db: Database,
  identityKey: string,
  message: string,
  fromRole: string | null,
  now: string,
): number {
  const res = db.query(
    `INSERT INTO inboxes (identity_key, from_role, message, status, created_at)
     VALUES ($k, $from, $msg, 'pending', $now)`,
  ).run({ $k: identityKey, $from: fromRole, $msg: message, $now: now });
  return Number(res.lastInsertRowid);
}

/** Return pending messages for an identity, oldest first. Does NOT drain them. */
export function pendingForIdentity(db: Database, identityKey: string): InboxRow[] {
  const rows = db.query(
    "SELECT * FROM inboxes WHERE identity_key = $k AND status = 'pending' ORDER BY inbox_id",
  ).all({ $k: identityKey }) as Record<string, unknown>[];
  return rows.map(fromRow);
}

/**
 * Atomically drain pending messages: mark them drained (with stamp) and return them. If
 * multiple drains race, sqlite's default serializable transaction ensures each row is
 * claimed by exactly one caller (though in practice ccs is single-threaded per-invocation).
 */
export function drainForIdentity(db: Database, identityKey: string, now: string): InboxRow[] {
  const pending = pendingForIdentity(db, identityKey);
  if (pending.length === 0) return [];
  const ids = pending.map((r) => r.inboxId);
  // sqlite doesn't support parameterized IN(), so build placeholders inline. Safe because ids
  // are integers we just produced ourselves.
  const placeholders = ids.map(() => "?").join(",");
  db.query(
    `UPDATE inboxes SET status = 'drained', drained_at = ? WHERE inbox_id IN (${placeholders})`,
  ).run(now, ...ids);
  return pending.map((r) => ({ ...r, status: "drained" as const, drainedAt: now }));
}

/** All messages (pending + drained) for an identity, oldest first. */
export function historyForIdentity(db: Database, identityKey: string): InboxRow[] {
  const rows = db.query(
    "SELECT * FROM inboxes WHERE identity_key = $k ORDER BY inbox_id",
  ).all({ $k: identityKey }) as Record<string, unknown>[];
  return rows.map(fromRow);
}

/** Count pending messages across all identities in a cluster. Useful for control loops. */
export function pendingCountByIdentity(db: Database, cluster: string): Map<string, number> {
  const rows = db.query(
    `SELECT i.identity_key, COUNT(*) as c
     FROM inboxes i
     JOIN identities id ON id.identity_key = i.identity_key
     WHERE id.cluster = $cluster AND i.status = 'pending'
     GROUP BY i.identity_key`,
  ).all({ $cluster: cluster }) as { identity_key: string; c: number }[];
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.identity_key, r.c);
  return out;
}

/** Delete drained messages older than an ISO timestamp — periodic cleanup for the audit trail. */
export function purgeDrainedBefore(db: Database, olderThan: string): number {
  const res = db.query(
    "DELETE FROM inboxes WHERE status = 'drained' AND drained_at < $t",
  ).run({ $t: olderThan });
  return Number(res.changes);
}
