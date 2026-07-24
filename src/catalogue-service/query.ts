import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
  CATALOGUE_PROTOCOL_VERSION,
  CLAUDE_PROVIDER_INSTANCE_ID,
  type CatalogueRootSession,
  type CatalogueSort,
  type RootSessionQuery,
} from "./protocol.ts";

const CursorSchema = z
  .object({
    version: z.literal(CATALOGUE_PROTOCOL_VERSION),
    generation: z.number().int().nonnegative(),
    sort: z.enum(["nativeActivity", "cwd", "title"]),
    filterKey: z.string().length(16),
    issuedAt: z.string().datetime(),
    sortValue: z.string(),
    sessionId: z.string().min(1),
  })
  .strict();

type Cursor = z.infer<typeof CursorSchema>;
type SqlValue = string | number;

interface RawRootSession {
  readonly sessionId: string;
  readonly host: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly branch: string | null;
  readonly firstActivityAt: string | null;
  readonly latestActivityAt: string | null;
  readonly messageCount: number;
  readonly observedSize: number;
  readonly observedMtimeMs: number;
  readonly title: string;
  readonly titleSource: "native" | "codex" | "fallback";
  readonly nativeSessionId: string;
  readonly sortValue: string;
}

export interface IndexedSourceCandidate extends RawRootSession {
  readonly sourcePath: string;
}

export type CatalogueQueryError =
  | { readonly code: "bad_request"; readonly message: string }
  | { readonly code: "stale_cursor"; readonly message: string };

export type CatalogueQueryResult =
  | {
      readonly ok: true;
      readonly sessions: readonly CatalogueRootSession[];
      readonly nextCursor: string | null;
    }
  | { readonly ok: false; readonly error: CatalogueQueryError };

const ROOT_SOURCE_PREDICATE = `
  s.is_subagent = 0
  AND s.resume_id <> ''
  AND s.cwd IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM catalogue_hidden_sessions AS hidden
    WHERE hidden.session_id = s.session_id
  )
`;

function titleSql(): string {
  // fallback_label is derived from the first human transcript turn. Keep that private to CCS's
  // local UI; the cross-product protocol emits a neutral metadata-only fallback instead.
  return "COALESCE(s.native_title, s.codex_title, 'Claude session ' || SUBSTR(s.resume_id, 1, 8))";
}

function sortSql(sort: CatalogueSort): { readonly expression: string; readonly direction: "ASC" | "DESC" } {
  switch (sort) {
    case "nativeActivity":
      return { expression: "COALESCE(s.last_ts, '')", direction: "DESC" };
    case "cwd":
      return { expression: "LOWER(COALESCE(s.cwd, ''))", direction: "ASC" };
    case "title":
      return { expression: `LOWER(${titleSql()})`, direction: "ASC" };
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function activityCutoff(window: RootSessionQuery["activityWindow"], referenceMs: number): string | null {
  switch (window) {
    case "all":
      return null;
    case "today": {
      const date = new Date(referenceMs);
      date.setHours(0, 0, 0, 0);
      return date.toISOString();
    }
    case "7d":
      return new Date(referenceMs - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d":
      return new Date(referenceMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
}

function filterKey(query: RootSessionQuery): string {
  const serialized = JSON.stringify({
    query: query.query ?? null,
    cwd: query.cwd ?? null,
    cwdPrefix: query.cwdPrefix ?? null,
    projectRoot: query.projectRoot ?? null,
    activityWindow: query.activityWindow,
    sort: query.sort,
  });
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function decodeCursor(encoded: string): Cursor | null {
  try {
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    const parsed = CursorSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function mapRootSession(row: RawRootSession): CatalogueRootSession {
  return {
    providerInstanceId: CLAUDE_PROVIDER_INSTANCE_ID,
    localSourceHost: row.host,
    nativeSessionId: row.nativeSessionId,
    sourceCwd: row.cwd,
    projectRoot: row.projectRoot,
    projectName: row.projectName,
    title: row.title,
    titleSource: row.titleSource,
    branch: row.branch,
    firstActivityAt: row.firstActivityAt,
    latestActivityAt: row.latestActivityAt,
    messageCount: row.messageCount,
    observedSize: row.observedSize,
    observedMtimeMs: row.observedMtimeMs,
  };
}

/** Query root, resumable native Claude sessions with generation-bound keyset pagination. */
export function queryRootSessions(
  db: Database,
  query: RootSessionQuery,
  generation: number,
  nowMs: number,
): CatalogueQueryResult {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) {
    return { ok: false, error: { code: "bad_request", message: "Invalid catalogue cursor." } };
  }
  const expectedFilterKey = filterKey(query);
  if (cursor) {
    if (
      cursor.generation !== generation ||
      cursor.sort !== query.sort ||
      cursor.filterKey !== expectedFilterKey
    ) {
      return {
        ok: false,
        error: {
          code: "stale_cursor",
          message: "The catalogue changed or the query filters differ; restart from the first page.",
        },
      };
    }
  }

  const referenceMs = cursor ? Date.parse(cursor.issuedAt) : nowMs;
  if (!Number.isFinite(referenceMs)) {
    return { ok: false, error: { code: "bad_request", message: "Invalid catalogue cursor time." } };
  }

  const params: Record<string, SqlValue> = { $limit: query.limit + 1 };
  const predicates = [ROOT_SOURCE_PREDICATE];
  if (query.query) {
    params.$query = `%${escapeLike(query.query.toLowerCase())}%`;
    predicates.push(`(
      LOWER(${titleSql()}) LIKE $query ESCAPE '\\'
      OR LOWER(COALESCE(s.cwd, '')) LIKE $query ESCAPE '\\'
      OR LOWER(s.project_name) LIKE $query ESCAPE '\\'
      OR LOWER(s.resume_id) LIKE $query ESCAPE '\\'
    )`);
  }
  if (query.cwd) {
    params.$cwd = query.cwd;
    predicates.push("s.cwd = $cwd");
  }
  if (query.cwdPrefix) {
    const cleanPrefix = query.cwdPrefix.replace(/[\\/]+$/, "");
    params.$cwdPrefix = `${escapeLike(cleanPrefix)}/%`;
    params.$cwdPrefixExact = cleanPrefix;
    predicates.push("(s.cwd = $cwdPrefixExact OR s.cwd LIKE $cwdPrefix ESCAPE '\\')");
  }
  if (query.projectRoot) {
    params.$projectRoot = query.projectRoot;
    predicates.push("s.project_root = $projectRoot");
  }
  const cutoff = activityCutoff(query.activityWindow, referenceMs);
  if (cutoff) {
    params.$activityCutoff = cutoff;
    predicates.push("s.last_ts >= $activityCutoff");
  }

  const sort = sortSql(query.sort);
  if (cursor) {
    params.$cursorValue = cursor.sortValue;
    params.$cursorId = cursor.sessionId;
    const comparator = sort.direction === "DESC" ? "<" : ">";
    predicates.push(`(
      ${sort.expression} ${comparator} $cursorValue
      OR (${sort.expression} = $cursorValue AND s.session_id > $cursorId)
    )`);
  }

  const rows = db
    .query(
      `SELECT
         s.session_id AS sessionId,
         s.host AS host,
         s.cwd AS cwd,
         s.project_root AS projectRoot,
         s.project_name AS projectName,
         s.branch AS branch,
         s.first_ts AS firstActivityAt,
         s.last_ts AS latestActivityAt,
         s.msg_count AS messageCount,
         s.file_size AS observedSize,
         s.file_mtime AS observedMtimeMs,
         ${titleSql()} AS title,
         CASE
           WHEN s.native_title IS NOT NULL THEN 'native'
           WHEN s.codex_title IS NOT NULL THEN 'codex'
           ELSE 'fallback'
         END AS titleSource,
         s.resume_id AS nativeSessionId,
         ${sort.expression} AS sortValue
       FROM sessions AS s
       WHERE ${predicates.join(" AND ")}
       ORDER BY ${sort.expression} ${sort.direction}, s.session_id ASC
       LIMIT $limit`,
    )
    .all(params) as RawRootSession[];

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const last = pageRows.at(-1);
  const issuedAt = cursor?.issuedAt ?? new Date(referenceMs).toISOString();
  const nextCursor = hasMore && last
    ? encodeCursor({
        version: CATALOGUE_PROTOCOL_VERSION,
        generation,
        sort: query.sort,
        filterKey: expectedFilterKey,
        issuedAt,
        sortValue: last.sortValue,
        sessionId: last.sessionId,
      })
    : null;

  return { ok: true, sessions: pageRows.map(mapRootSession), nextCursor };
}

/** Indexed candidates for a resume UUID. The caller revalidates path, CWD, and file signature. */
export function sourceCandidates(db: Database, resumeId: string): IndexedSourceCandidate[] {
  return db
    .query(
      `SELECT
         s.session_id AS sessionId,
         s.host AS host,
         s.path AS sourcePath,
         s.cwd AS cwd,
         s.project_root AS projectRoot,
         s.project_name AS projectName,
         s.branch AS branch,
         s.first_ts AS firstActivityAt,
         s.last_ts AS latestActivityAt,
         s.msg_count AS messageCount,
         s.file_size AS observedSize,
         s.file_mtime AS observedMtimeMs,
         ${titleSql()} AS title,
         CASE
           WHEN s.native_title IS NOT NULL THEN 'native'
           WHEN s.codex_title IS NOT NULL THEN 'codex'
           ELSE 'fallback'
         END AS titleSource,
         s.resume_id AS nativeSessionId,
         COALESCE(s.last_ts, '') AS sortValue
       FROM sessions AS s
       WHERE ${ROOT_SOURCE_PREDICATE}
         AND s.resume_id = $resumeId
       ORDER BY s.session_id ASC`,
    )
    .all({ $resumeId: resumeId }) as IndexedSourceCandidate[];
}

export function countRootSessions(db: Database): number {
  const row = db
    .query(`SELECT COUNT(*) AS count FROM sessions AS s WHERE ${ROOT_SOURCE_PREDICATE}`)
    .get() as { count: number };
  return row.count;
}

export function toRootSession(row: IndexedSourceCandidate): CatalogueRootSession {
  return mapRootSession(row);
}
