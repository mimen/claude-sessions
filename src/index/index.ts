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
  /** True when this file is a subagent task run (every message is a sidechain). */
  readonly isSubagent: boolean;
  /** Parent Session id for a subagent run; null for normal sessions. */
  readonly parentSessionId: string | null;
  /** The id to pass to `claude --resume` (internal sessionId, not the filename). */
  readonly resumeId: string;
  /** API-equivalent USD cost of this file's own usage (subagent runs are separate rows). */
  readonly costUSD: number;
  /** Billed token totals for this file's own usage. */
  readonly tokInput: number;
  readonly tokOutput: number;
  readonly tokCacheRead: number;
  readonly tokCacheWrite: number;
  /** USD per model id for this file — drives the model indicator + per-model breakdown. */
  readonly costByModel: Readonly<Record<string, number>>;
  /** Real prompts / ticks (human/loop turns, excluding tool-result lines). */
  readonly userTurns: number;
  /** Median seconds between ticks — a loop's cadence (0 if fewer than two ticks). */
  readonly tickIntervalSec: number;
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
  END AS titleSource,
  is_subagent AS isSubagent,
  parent_session_id AS parentSessionId,
  resume_id AS resumeId,
  cost_usd AS costUSD,
  tok_input AS tokInput,
  tok_output AS tokOutput,
  tok_cache_read AS tokCacheRead,
  tok_cache_write AS tokCacheWrite,
  cost_by_model AS costByModelJson,
  user_turns AS userTurns,
  tick_interval_sec AS tickIntervalSec
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
      native_title, fallback_label, skeleton, is_subagent, parent_session_id, resume_id,
      cost_usd, tok_input, tok_output, tok_cache_read, tok_cache_write, cost_by_model,
      user_turns, tick_interval_sec
    ) VALUES (
      $session_id, $host, $path, $cwd, $project_root, $project_name, $branch, $version,
      $first_ts, $last_ts, $msg_count, $file_mtime, $file_size,
      $native_title, $fallback_label, $skeleton, $is_subagent, $parent_session_id, $resume_id,
      $cost_usd, $tok_input, $tok_output, $tok_cache_read, $tok_cache_write, $cost_by_model,
      $user_turns, $tick_interval_sec
    )
    ON CONFLICT(session_id) DO UPDATE SET
      host = $host, path = $path, cwd = $cwd,
      project_root = $project_root, project_name = $project_name,
      branch = $branch, version = $version,
      first_ts = $first_ts, last_ts = $last_ts, msg_count = $msg_count,
      file_mtime = $file_mtime, file_size = $file_size,
      native_title = $native_title, fallback_label = $fallback_label, skeleton = $skeleton,
      is_subagent = $is_subagent, parent_session_id = $parent_session_id, resume_id = $resume_id,
      cost_usd = $cost_usd, tok_input = $tok_input, tok_output = $tok_output,
      tok_cache_read = $tok_cache_read, tok_cache_write = $tok_cache_write,
      cost_by_model = $cost_by_model,
      user_turns = $user_turns, tick_interval_sec = $tick_interval_sec
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

    // One unreadable/locked/deleted-mid-scan file must not abort the whole reindex.
    let parsed;
    try {
      parsed = await parseSessionFile(file.path, file.sessionId);
    } catch {
      stats.skipped++;
      continue;
    }
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
      $is_subagent: parsed.isSubagent ? 1 : 0,
      $parent_session_id: parsed.parentSessionId,
      $resume_id: parsed.resumeId,
      $cost_usd: parsed.usage.costUSD,
      $tok_input: parsed.usage.input,
      $tok_output: parsed.usage.output,
      $tok_cache_read: parsed.usage.cacheRead,
      $tok_cache_write: parsed.usage.cacheWrite5m + parsed.usage.cacheWrite1h,
      $cost_by_model: JSON.stringify(parsed.usage.costByModel),
      $user_turns: parsed.userTurns,
      $tick_interval_sec: parsed.tickIntervalSec,
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
         AND is_subagent = 0
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

type RawRow = Omit<SessionRow, "isSubagent" | "costByModel"> & {
  isSubagent: number;
  costByModelJson: string;
};

/** Coerce SQLite's 0/1 is_subagent into a boolean and parse the per-model cost JSON. */
function mapRows(raw: unknown[]): SessionRow[] {
  return (raw as RawRow[]).map((r) => {
    const { costByModelJson, ...rest } = r;
    let costByModel: Record<string, number> = {};
    try {
      costByModel = JSON.parse(costByModelJson) as Record<string, number>;
    } catch {
      // tolerate a corrupt cell; the scalar totals are still correct
    }
    return { ...rest, isSubagent: Boolean(r.isSubagent), costByModel };
  });
}

/** The subagent runs spawned by a given parent Session, most-recent first. */
export function childrenOf(db: Database, parentSessionId: string): SessionRow[] {
  return mapRows(
    db
      .query(`SELECT ${SELECT_COLS} FROM sessions WHERE parent_session_id = $pid ORDER BY last_ts DESC NULLS LAST`)
      .all({ $pid: parentSessionId }),
  );
}

/** Full token/cost detail for one Session (drives `ccs meta`). */
export interface SessionUsage {
  readonly costUSD: number;
  readonly tokInput: number;
  readonly tokOutput: number;
  readonly tokCacheRead: number;
  readonly tokCacheWrite: number;
  readonly costByModel: Readonly<Record<string, number>>;
}

/** Token/cost detail for a Session id, or null if it isn't indexed. */
export function usageOf(db: Database, sessionId: string): SessionUsage | null {
  const row = db
    .query(
      `SELECT cost_usd AS costUSD, tok_input AS tokInput, tok_output AS tokOutput,
              tok_cache_read AS tokCacheRead, tok_cache_write AS tokCacheWrite,
              cost_by_model AS costByModelJson
       FROM sessions WHERE session_id = $id`,
    )
    .get({ $id: sessionId }) as
    | (Omit<SessionUsage, "costByModel"> & { costByModelJson: string })
    | null;
  if (!row) return null;
  let costByModel: Record<string, number> = {};
  try {
    costByModel = JSON.parse(row.costByModelJson) as Record<string, number>;
  } catch {
    // tolerate a corrupt cell; the totals are still right
  }
  const { costByModelJson: _, ...rest } = row;
  return { ...rest, costByModel };
}

/** The cost column alone for a Session id (0 when unindexed) — cheap per-node lookup for `tree`. */
export function costOf(db: Database, sessionId: string): number {
  const row = db
    .query("SELECT cost_usd AS costUSD FROM sessions WHERE session_id = $id")
    .get({ $id: sessionId }) as { costUSD: number } | null;
  return row?.costUSD ?? 0;
}

/**
 * Summed cost of one Session's subagent runs. Subagent rows key their parent by the parent's
 * INTERNAL sessionId, so we match on both the given id and its resume_id (they differ for
 * resumed/forked sessions).
 */
export function subagentCostOf(db: Database, sessionId: string): number {
  const row = db
    .query(
      `SELECT SUM(cost_usd) AS usd FROM sessions
       WHERE is_subagent = 1 AND parent_session_id IN (
         SELECT resume_id FROM sessions WHERE session_id = $id
         UNION SELECT $id
       )`,
    )
    .get({ $id: sessionId }) as { usd: number | null };
  return row.usd ?? 0;
}

/** Map of parent Session id → summed cost of its subagent runs (agent-*.jsonl files). */
export function subagentCosts(db: Database): Map<string, number> {
  const rows = db
    .query(
      `SELECT parent_session_id AS pid, SUM(cost_usd) AS usd FROM sessions
       WHERE is_subagent = 1 AND parent_session_id IS NOT NULL GROUP BY parent_session_id`,
    )
    .all() as Array<{ pid: string; usd: number }>;
  return new Map(rows.map((r) => [r.pid, r.usd]));
}

/** Map of parent Session id → number of subagent runs it spawned. */
export function subagentCounts(db: Database): Map<string, number> {
  const rows = db
    .query(
      `SELECT parent_session_id AS pid, COUNT(*) AS n FROM sessions
       WHERE is_subagent = 1 AND parent_session_id IS NOT NULL GROUP BY parent_session_id`,
    )
    .all() as Array<{ pid: string; n: number }>;
  return new Map(rows.map((r) => [r.pid, r.n]));
}

/** All Sessions, most-recently-active first. Subagent runs are excluded by default. */
export function listByRecency(db: Database, includeSubagents = false): SessionRow[] {
  const where = includeSubagents ? "" : "WHERE is_subagent = 0";
  return mapRows(
    db.query(`SELECT ${SELECT_COLS} FROM sessions ${where} ORDER BY last_ts DESC NULLS LAST`).all(),
  );
}

/** Session IDs whose title or skeleton match an FTS query (for content search in the TUI). */
export function ftsMatchIds(db: Database, query: string): Set<string> {
  const trimmed = query.trim();
  if (!trimmed) return new Set();
  // FTS5 can throw on syntactically odd queries; a search keystroke must never crash the TUI.
  try {
    const rows = db
      .query("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH $q")
      .all({ $q: ftsQuery(trimmed) }) as Array<{ session_id: string }>;
    return new Set(rows.map((r) => r.session_id));
  } catch {
    return new Set();
  }
}

/** The resolved Title for a single Session id, or null if it isn't indexed (e.g. a forward ref). */
export function titleOf(db: Database, sessionId: string): string | null {
  const row = db
    .query(
      "SELECT COALESCE(native_title, codex_title, fallback_label) AS title FROM sessions WHERE session_id = $id",
    )
    .get({ $id: sessionId }) as { title: string } | null;
  return row?.title ?? null;
}

/** The stored skeleton for a Session (first/last turns) — the preview-pane content peek. */
export function getSkeleton(db: Database, sessionId: string): string {
  const row = db
    .query("SELECT skeleton FROM sessions WHERE session_id = $id")
    .get({ $id: sessionId }) as { skeleton: string } | null;
  return row?.skeleton ?? "";
}

/** FTS search over title + skeleton, ranked, returning full rows. */
export function search(db: Database, query: string, includeSubagents = false): SessionRow[] {
  const trimmed = query.trim();
  if (!trimmed) return listByRecency(db, includeSubagents);
  const subagentFilter = includeSubagents ? "" : "AND is_subagent = 0";
  // A malformed FTS query must degrade to "no matches", never crash the caller.
  try {
    return mapRows(
      db
        .query(
          `SELECT ${SELECT_COLS} FROM sessions
           WHERE session_id IN (
             SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH $q ORDER BY rank
           ) ${subagentFilter}
           ORDER BY last_ts DESC NULLS LAST`,
        )
        .all({ $q: ftsQuery(trimmed) }),
    );
  } catch {
    return [];
  }
}

/** Turn free text into a prefix-OR FTS5 query, escaping each token as a quoted string. */
function ftsQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => `"${tok.replace(/"/g, '""')}"*`)
    .join(" OR ");
}
