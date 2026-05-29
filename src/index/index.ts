import type { Database } from "bun:sqlite";
import type { StoredSessionFile } from "../store.ts";
import { parseSessionFile } from "../parse.ts";
import { deriveProject } from "../project.ts";
import { cleanLabel } from "../label.ts";

/** A Session row as surfaced to the browse layer, with the Title already resolved. */
export interface SessionRow {
  readonly sessionId: string;
  readonly host: string;
  readonly path: string;
  readonly cwd: string | null;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly branch: string | null;
  readonly version: string | null;
  readonly firstTs: string | null;
  readonly lastTs: string | null;
  readonly msgCount: number;
  readonly fileSize: number;
  /** Resolved: native title → codex title → cleaned-first-message fallback. */
  readonly title: string;
  readonly titleSource: "native" | "codex" | "fallback";
}

export interface ReindexStats {
  scanned: number;
  parsed: number;
  skipped: number;
  removed: number;
}

interface ExistingMeta {
  file_mtime: number;
  file_size: number;
}

// COALESCE order encodes Title priority; titleSource reports which one won.
const SELECT_COLS = `
  session_id AS sessionId, host, path, cwd,
  project_root AS projectRoot, project_name AS projectName,
  branch, version, first_ts AS firstTs, last_ts AS lastTs,
  msg_count AS msgCount, file_size AS fileSize,
  COALESCE(native_title, codex_title, fallback_label) AS title,
  CASE
    WHEN native_title IS NOT NULL THEN 'native'
    WHEN codex_title  IS NOT NULL THEN 'codex'
    ELSE 'fallback'
  END AS titleSource
`;

/**
 * Incrementally refresh the Index from the Store. Only Session files whose mtime/size
 * changed are re-parsed; titler-owned columns (codex_title, attempts, title_msg_count)
 * are preserved across re-parses. Rows for vanished files are removed.
 */
export async function reindexStore(
  db: Database,
  files: readonly StoredSessionFile[],
  host: string,
): Promise<ReindexStats> {
  const existing = new Map<string, ExistingMeta>();
  for (const row of db.query("SELECT session_id, file_mtime, file_size FROM sessions").all() as Array<{
    session_id: string;
    file_mtime: number;
    file_size: number;
  }>) {
    existing.set(row.session_id, { file_mtime: row.file_mtime, file_size: row.file_size });
  }

  const upsert = db.query(`
    INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, branch, version,
      first_ts, last_ts, msg_count, file_mtime, file_size,
      native_title, fallback_label, skeleton
    ) VALUES (
      $session_id, $host, $path, $cwd, $project_root, $project_name, $branch, $version,
      $first_ts, $last_ts, $msg_count, $file_mtime, $file_size,
      $native_title, $fallback_label, $skeleton
    )
    ON CONFLICT(session_id) DO UPDATE SET
      host = $host, path = $path, cwd = $cwd,
      project_root = $project_root, project_name = $project_name,
      branch = $branch, version = $version,
      first_ts = $first_ts, last_ts = $last_ts, msg_count = $msg_count,
      file_mtime = $file_mtime, file_size = $file_size,
      native_title = $native_title, fallback_label = $fallback_label, skeleton = $skeleton
  `);
  const ftsDelete = db.query("DELETE FROM sessions_fts WHERE session_id = $id");
  const ftsInsert = db.query(
    "INSERT INTO sessions_fts (session_id, title, skeleton) VALUES ($id, $title, $skeleton)",
  );

  const stats: ReindexStats = { scanned: files.length, parsed: 0, skipped: 0, removed: 0 };
  const seen = new Set<string>();

  for (const file of files) {
    seen.add(file.sessionId);
    const prev = existing.get(file.sessionId);
    if (prev && prev.file_mtime === file.mtimeMs && prev.file_size === file.sizeBytes) {
      stats.skipped++;
      continue;
    }

    const parsed = await parseSessionFile(file.path, file.sessionId);
    const project = deriveProject(parsed.cwd);
    const fallback = cleanLabel(parsed.userTexts);

    upsert.run({
      $session_id: parsed.sessionId,
      $host: host,
      $path: file.path,
      $cwd: parsed.cwd,
      $project_root: project.root,
      $project_name: project.name,
      $branch: parsed.gitBranch,
      $version: parsed.version,
      $first_ts: parsed.firstTs,
      $last_ts: parsed.lastTs,
      $msg_count: parsed.msgCount,
      $file_mtime: file.mtimeMs,
      $file_size: file.sizeBytes,
      $native_title: parsed.nativeTitle,
      $fallback_label: fallback,
      $skeleton: parsed.skeleton,
    });

    // Keep FTS in step with the resolved title (native if present, else fallback for now;
    // codex titles refresh the FTS row when generated in M3).
    const ftsTitle = parsed.nativeTitle ?? fallback;
    ftsDelete.run({ $id: parsed.sessionId });
    ftsInsert.run({ $id: parsed.sessionId, $title: ftsTitle, $skeleton: parsed.skeleton });
    stats.parsed++;
  }

  // Remove rows whose files have disappeared from the Store.
  const removeRow = db.query("DELETE FROM sessions WHERE session_id = $id");
  for (const sessionId of existing.keys()) {
    if (!seen.has(sessionId)) {
      removeRow.run({ $id: sessionId });
      ftsDelete.run({ $id: sessionId });
      stats.removed++;
    }
  }

  return stats;
}

/** A Session needing a generated Title, with the skeleton to feed the Titler. */
export interface TitleCandidate {
  readonly sessionId: string;
  readonly skeleton: string;
}

/**
 * Sessions that need a Codex Title: no native title, attempts under the cap, and either
 * never titled or grown substantially since the last titling (staleness: >1.5× messages).
 */
export function titleCandidates(db: Database, maxAttempts: number): TitleCandidate[] {
  return db
    .query(
      `SELECT session_id AS sessionId, skeleton FROM sessions
       WHERE native_title IS NULL
         AND title_attempts < $max
         AND skeleton <> ''
         AND (
           codex_title IS NULL
           OR (title_msg_count IS NOT NULL AND msg_count > title_msg_count * 1.5)
         )
       ORDER BY last_ts DESC NULLS LAST`,
    )
    .all({ $max: maxAttempts }) as TitleCandidate[];
}

/** Persist a generated Title, stamp the message count at titling, and refresh the FTS row. */
export function saveCodexTitle(db: Database, sessionId: string, title: string): void {
  db.query(
    `UPDATE sessions
     SET codex_title = $title, title_msg_count = msg_count, title_attempts = 0
     WHERE session_id = $id`,
  ).run({ $id: sessionId, $title: title });

  // Resolved FTS title = native (none here, by definition) → codex title.
  db.query("DELETE FROM sessions_fts WHERE session_id = $id").run({ $id: sessionId });
  db.query(
    `INSERT INTO sessions_fts (session_id, title, skeleton)
     SELECT session_id, $title, skeleton FROM sessions WHERE session_id = $id`,
  ).run({ $id: sessionId, $title: title });
}

/** Record a failed titling attempt so a stuck Session eventually stops being retried. */
export function recordTitleFailure(db: Database, sessionId: string): void {
  db.query(
    "UPDATE sessions SET title_attempts = title_attempts + 1 WHERE session_id = $id",
  ).run({ $id: sessionId });
}

/** All Sessions, most-recently-active first. */
export function listByRecency(db: Database): SessionRow[] {
  return db
    .query(`SELECT ${SELECT_COLS} FROM sessions ORDER BY last_ts DESC NULLS LAST`)
    .all() as SessionRow[];
}

/** FTS search over title + skeleton, ranked, returning full rows. */
export function search(db: Database, query: string): SessionRow[] {
  const trimmed = query.trim();
  if (!trimmed) return listByRecency(db);
  return db
    .query(
      `SELECT ${SELECT_COLS} FROM sessions
       WHERE session_id IN (
         SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH $q ORDER BY rank
       )
       ORDER BY last_ts DESC NULLS LAST`,
    )
    .all({ $q: ftsQuery(trimmed) }) as SessionRow[];
}

/** Turn free text into a prefix-OR FTS5 query, escaping each token as a quoted string. */
function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok.replace(/"/g, '""')}"*`)
    .join(" OR ");
}
