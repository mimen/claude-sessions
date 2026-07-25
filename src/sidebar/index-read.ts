/**
 * Reading the session index without owning it.
 *
 * `openIndex` refuses a schema newer than the build understands, and it is right to: a writer
 * that misunderstands the shape can corrupt it. The sidebar never writes. It wants a handful of
 * columns that have been stable for many versions, so a newer *additive* schema is perfectly
 * readable and refusing it would blank the queue for no gain — which is exactly what happened
 * when another checkout migrated the shared index ahead of this build.
 *
 * So this module opens the index read-only, asks for only the columns it needs, and gives up
 * only when a column it actually uses is missing.
 */
import { Database } from "bun:sqlite";
import type { IndexedSessionInput } from "./projection.ts";

/** The columns the sidebar projection actually consumes. */
const REQUIRED_COLUMNS = [
  "session_id",
  "resume_id",
  "cwd",
  "last_ts",
  "models",
  "cost_by_model",
  "is_subagent",
] as const;

/** Title resolution mirrors the index's own priority, but only over columns that exist. */
const TITLE_COLUMNS = ["native_title", "codex_title", "fallback_label"] as const;

interface IndexRow {
  session_id: string;
  resume_id: string | null;
  title: string | null;
  cwd: string | null;
  last_ts: string | null;
  models: string | null;
  cost_by_model: string | null;
  msg_count: number | null;
}

function columnsOf(db: Database, table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface ReadIndexOptions {
  readonly limit: number;
  /** When present, return only rows addressed by one of these canonical or resume ids. */
  readonly sessionIds?: readonly string[];
}

const MAX_IDS_PER_QUERY = 400;

function compareIndexRecency(left: IndexRow, right: IndexRow): number {
  if (left.last_ts === right.last_ts) return left.session_id.localeCompare(right.session_id);
  if (left.last_ts === null) return 1;
  if (right.last_ts === null) return -1;
  return right.last_ts.localeCompare(left.last_ts);
}

/**
 * The most recent non-subagent sessions, newest first.
 *
 * Throws when the index cannot be read at all or has lost a column the projection needs; the
 * caller degrades to live cmux rows in that case rather than showing a broken page.
 */
export function readIndexReadOnly(
  dbPath: string,
  options: ReadIndexOptions,
): IndexedSessionInput[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const available = columnsOf(db, "sessions");
    const missing = REQUIRED_COLUMNS.filter((column) => !available.has(column));
    if (missing.length > 0) {
      throw new Error(`session index is missing column(s): ${missing.join(", ")}`);
    }

    // Optional, not required: it only ages the enrichment summary, so an index without it should
    // cost the summary its age — never the whole session list.
    const messageCountExpression = available.has("msg_count") ? "msg_count" : "NULL AS msg_count";
    const titleSources = TITLE_COLUMNS.filter((column) => available.has(column));
    // COALESCE keeps the index's own title priority; with no title column at all the row still
    // has an id, and the caller falls back to cmux's workspace title.
    const titleExpression = titleSources.length > 0
      ? `COALESCE(${titleSources.join(", ")})`
      : "NULL";

    const select =
      `SELECT session_id, resume_id, ${titleExpression} AS title, cwd, last_ts, models, cost_by_model,
              ${messageCountExpression}
         FROM sessions`;
    let rows: IndexRow[];

    if (options.sessionIds === undefined) {
      rows = db.query(
        `${select}
          WHERE is_subagent = 0
          ORDER BY last_ts DESC NULLS LAST, session_id
          LIMIT $limit`,
      ).all({ $limit: options.limit }) as IndexRow[];
    } else {
      const requestedIds = [...new Set(options.sessionIds)];
      const rowsBySessionId = new Map<string, IndexRow>();
      for (let offset = 0; offset < requestedIds.length; offset += MAX_IDS_PER_QUERY) {
        const chunk = requestedIds.slice(offset, offset + MAX_IDS_PER_QUERY);
        const bindings: Record<string, string | number> = { $limit: options.limit };
        const placeholders = chunk.map((sessionId, index) => {
          const placeholder = `$id${index}`;
          bindings[placeholder] = sessionId;
          return placeholder;
        });
        const joined = placeholders.join(", ");
        const matches = db.query(
          `${select}
            WHERE is_subagent = 0
              AND (session_id IN (${joined}) OR resume_id IN (${joined}))
            ORDER BY last_ts DESC NULLS LAST, session_id
            LIMIT $limit`,
        ).all(bindings) as IndexRow[];
        for (const row of matches) rowsBySessionId.set(row.session_id, row);
      }
      // An empty lifecycle has no rows, but opening and validating the index above still reports
      // whether history is unavailable because the index itself is unreadable.
      rows = [...rowsBySessionId.values()].sort(compareIndexRecency).slice(0, options.limit);
    }

    return rows.map((row) => ({
      sessionId: row.session_id,
      resumeId: row.resume_id ?? row.session_id,
      title: row.title ?? "",
      cwd: row.cwd,
      lastTs: row.last_ts,
      models: parseJson<string[]>(row.models, []),
      costByModel: parseJson<Record<string, number>>(row.cost_by_model, {}),
      messageCount: row.msg_count ?? null,
    }));
  } finally {
    db.close();
  }
}
