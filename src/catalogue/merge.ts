import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getAll, rowFrom, type CatalogueRow } from "./db.ts";
import { TITLE_SQL } from "../index/index.ts";

/**
 * The Merged View (issue 33, PRD 08): one fleet-wide catalogue built on the always-on Host
 * from every Host's data dir (its own + each replica that replicate.py delivers), then read
 * anywhere. Purely derived and rebuildable — deletable without loss, like the Index; never
 * synced, never in the vault.
 *
 * Replicas are ARCHIVE data: sources are never opened in place. Each source is snapshot-copied
 * (db + -wal + -shm) into a temp dir first, so sqlite's WAL recovery, our own migrations, and
 * schema-version drops can only ever touch the disposable copy. A source that still fails to
 * read is skipped WITH A NOTE — one torn replica must not take down the fleet view.
 *
 * Ownership: a session belongs to the Host whose Index holds its transcript — each Host indexes
 * only its own store, so provenance is unambiguous. On a catalogue conflict (a pre-33
 * cross-write), the OWNER's row wins regardless of timestamps; rows no index knows fall back
 * to newest updated_at.
 */

export interface MergeSource {
  /** The Host this dir belongs to (replica dir name = replicate.py's hostname key). */
  readonly host: string;
  /** A ccs data dir: catalogue.db + index.db (either may be absent). */
  readonly dir: string;
}

export interface MergedRow extends CatalogueRow {
  readonly host: string;
  /** Index snapshot from the owning Host (resolved Title; null when never indexed). */
  readonly title: string | null;
  readonly lastTs: string | null;
  readonly projectName: string | null;
}

/** Catalogue columns + merge extras, listed once — schema, INSERT, and params derive from it. */
const MERGED_COLS = [
  "session_id", "host", "resume_id", "custom_title", "kind", "completed", "archived",
  "parked_task_id", "event", "parent_session_id", "skill", "project", "role", "substrate",
  "identity", "notes", "updated_at", "title", "last_ts", "project_name",
] as const;

const MERGE_SCHEMA = `
  CREATE TABLE merged (
    session_id        TEXT PRIMARY KEY,
    host              TEXT NOT NULL,
    resume_id         TEXT,
    custom_title      TEXT,
    kind              TEXT NOT NULL DEFAULT 'session',
    completed         INTEGER NOT NULL DEFAULT 0,
    archived          INTEGER NOT NULL DEFAULT 0,
    parked_task_id    TEXT,
    event             TEXT,
    parent_session_id TEXT,
    skill             TEXT,
    project           TEXT,
    role              TEXT,
    substrate         TEXT,
    identity          TEXT,
    notes             TEXT,
    updated_at        TEXT,
    title             TEXT,
    last_ts           TEXT,
    project_name      TEXT
  );
  CREATE INDEX idx_merged_host ON merged(host);
  CREATE INDEX idx_merged_role ON merged(role);
  CREATE TABLE merged_tags (
    session_id TEXT NOT NULL,
    entity     TEXT NOT NULL,
    host       TEXT NOT NULL,
    PRIMARY KEY (session_id, entity)
  );
  CREATE TABLE merged_meta (key TEXT PRIMARY KEY, value TEXT);
`;

interface IndexSnapshot {
  readonly title: string | null;
  readonly lastTs: string | null;
  readonly projectName: string | null;
}

/** Everything one source knows: its catalogue rows, tags, and index snapshots. */
interface SourceData {
  readonly host: string;
  readonly catalogue: Map<string, CatalogueRow>;
  readonly tags: Array<{ sessionId: string; entity: string }>;
  readonly index: Map<string, IndexSnapshot>;
}

/** Copy a sqlite db (with WAL sidecars) into `dir` so nothing ever opens the source itself. */
function snapshotDb(sourcePath: string, dir: string, name: string): string | null {
  if (!existsSync(sourcePath)) return null;
  const dest = join(dir, name);
  copyFileSync(sourcePath, dest);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(sourcePath + suffix)) copyFileSync(sourcePath + suffix, dest + suffix);
  }
  return dest;
}

/** Read one source through disposable snapshots. Throws on unreadable data — caller contains. */
function readSource(source: MergeSource, scratch: string): SourceData {
  let catalogue = new Map<string, CatalogueRow>();
  let tags: Array<{ sessionId: string; entity: string }> = [];
  const catCopy = snapshotDb(join(source.dir, "catalogue.db"), scratch, `${source.host}-catalogue.db`);
  if (catCopy) {
    // openCatalogue migrates — safe and USEFUL on the copy: an older replica's schema is
    // normalized to current, so getAll/rowFrom read it uniformly. The replica is untouched.
    const db = openCatalogue(catCopy);
    try {
      catalogue = getAll(db);
      tags = db.query("SELECT session_id AS sessionId, entity FROM session_tags").all() as Array<{
        sessionId: string;
        entity: string;
      }>;
    } finally {
      db.close();
    }
  }
  const index = new Map<string, IndexSnapshot>();
  const idxCopy = snapshotDb(join(source.dir, "index.db"), scratch, `${source.host}-index.db`);
  if (idxCopy) {
    // NEVER openIndex here: it drops-and-recreates on version mismatch. Raw reads only —
    // if this replica's schema is too old for the query, the throw is contained per-source.
    const db = new Database(idxCopy);
    try {
      const rows = db
        .query(
          `SELECT session_id AS sessionId, ${TITLE_SQL} AS title,
                  last_ts AS lastTs, project_name AS projectName
           FROM sessions WHERE is_subagent = 0`,
        )
        .all() as Array<{ sessionId: string } & IndexSnapshot>;
      for (const r of rows) {
        index.set(r.sessionId, { title: r.title, lastTs: r.lastTs, projectName: r.projectName });
      }
    } finally {
      db.close();
    }
  }
  return { host: source.host, catalogue, tags, index };
}

export interface MergeStats {
  sessions: number;
  tags: number;
  sources: number;
  /** Sources that could not be read (torn replica mid-rsync, etc.) — reported, never fatal. */
  readonly skipped: string[];
}

/** Build (atomically replace) the merged view from the given sources. */
export function buildMerge(sources: readonly MergeSource[], outPath: string, now: string): MergeStats {
  const scratch = mkdtempSync(join(tmpdir(), "ccs-merge-src-"));
  const data: SourceData[] = [];
  const skipped: string[] = [];
  try {
    for (const source of sources) {
      try {
        data.push(readSource(source, scratch));
      } catch (e) {
        // A torn/corrupt source (rsync mid-write) skips THIS source only, loudly.
        skipped.push(`${source.host}: ${(e as Error).message}`);
      }
    }

    // Owner of a session = the Host whose index holds its transcript.
    const owner = new Map<string, SourceData>();
    for (const s of data) {
      for (const id of s.index.keys()) {
        if (!owner.has(id)) owner.set(id, s);
      }
    }

    // Union of everything any source knows about.
    const allIds = new Set<string>();
    for (const s of data) {
      for (const id of s.index.keys()) allIds.add(id);
      for (const id of s.catalogue.keys()) allIds.add(id);
    }

    /** Newest catalogue write for a session across sources (excluding one, when asked). */
    const newestHolder = (id: string, exclude?: SourceData): SourceData | null => {
      let best: SourceData | null = null;
      for (const s of data) {
        if (s === exclude || !s.catalogue.has(id)) continue;
        if (
          !best ||
          (s.catalogue.get(id)!.updatedAt ?? "").localeCompare(best.catalogue.get(id)!.updatedAt ?? "") > 0
        ) {
          best = s;
        }
      }
      return best;
    };

    const pick = (id: string): { host: string; row: CatalogueRow | null; snap: IndexSnapshot | null } => {
      const own = owner.get(id);
      if (own) {
        const row = own.catalogue.get(id) ?? newestHolder(id, own)?.catalogue.get(id) ?? null;
        return { host: own.host, row, snap: own.index.get(id) ?? null };
      }
      // No index knows it: catalogue-only row (forward ref, remote body) — newest write wins.
      const holder = newestHolder(id)!;
      return { host: holder.host, row: holder.catalogue.get(id)!, snap: null };
    };

    // Build into a temp file, then swap — a reader never sees a half-built merge.
    const tmpPath = `${outPath}.building`;
    rmSync(tmpPath, { force: true }); // leftovers from a crashed build
    const db = new Database(tmpPath, { create: true });
    let sessions = 0;
    let tagCount = 0;
    try {
      db.exec(MERGE_SCHEMA);
      const insert = db.query(
        `INSERT INTO merged (${MERGED_COLS.join(", ")})
         VALUES (${MERGED_COLS.map((c) => `$${c}`).join(", ")})`,
      );
      const insertTag = db.query(
        "INSERT INTO merged_tags (session_id, entity, host) VALUES ($id, $e, $h) ON CONFLICT DO NOTHING",
      );
      const meta = db.query("INSERT INTO merged_meta (key, value) VALUES ($k, $v)");
      // One transaction: per-statement autocommit fsyncs ~200x slower and buys nothing —
      // the temp-file + rename swap is what makes the build crash-safe.
      db.transaction(() => {
        for (const id of allIds) {
          const { host, row, snap } = pick(id);
          insert.run({
            $session_id: id,
            $host: host,
            $resume_id: row?.resumeId ?? null,
            $custom_title: row?.customTitle ?? null,
            $kind: row?.kind ?? "session",
            $completed: row?.completed ? 1 : 0,
            $archived: row?.archived ? 1 : 0,
            $parked_task_id: row?.parkedTaskId ?? null,
            $event: row?.event ?? null,
            $parent_session_id: row?.parentSessionId ?? null,
            $skill: row?.skill ?? null,
            $project: row?.project ?? null,
            $role: row?.role ?? null,
            $substrate: row?.substrate ?? null,
            $identity: row?.identity ?? null,
            $notes: row?.notes ?? null,
            $updated_at: row?.updatedAt ?? null,
            $title: snap?.title ?? null,
            $last_ts: snap?.lastTs ?? null,
            $project_name: snap?.projectName ?? null,
          });
          sessions++;
        }
        for (const s of data) {
          for (const t of s.tags) {
            const res = insertTag.run({ $id: t.sessionId, $e: t.entity, $h: s.host });
            tagCount += res.changes;
          }
        }
        meta.run({ $k: "merged_at", $v: now });
        meta.run({ $k: "sources", $v: JSON.stringify(data.map((s) => s.host)) });
        if (skipped.length) meta.run({ $k: "skipped_sources", $v: JSON.stringify(skipped) });
      })();
    } finally {
      db.close();
    }
    renameSync(tmpPath, outPath);
    return { sessions, tags: tagCount, sources: data.length, skipped };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Open an existing merged view; null when it hasn't been built/pulled yet. */
export function openMerge(path: string): Database | null {
  if (!existsSync(path)) return null;
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function toMergedRow(r: Record<string, unknown>): MergedRow {
  return {
    ...rowFrom(r)!, // the ONE catalogue column decoder (merged carries the same columns)
    host: r.host as string,
    title: (r.title as string) ?? null,
    lastTs: (r.last_ts as string) ?? null,
    projectName: (r.project_name as string) ?? null,
  };
}

/** Every merged row, most recently active first. */
export function mergedRows(db: Database): MergedRow[] {
  const rows = db.query("SELECT * FROM merged ORDER BY last_ts DESC NULLS LAST").all() as Record<
    string,
    unknown
  >[];
  return rows.map(toMergedRow);
}

/** Which Host owns a session per the merged view; null when the merge doesn't know it. */
export function ownerOf(db: Database, sessionId: string): string | null {
  const r = db.query("SELECT host FROM merged WHERE session_id = $id").get({ $id: sessionId }) as {
    host: string;
  } | null;
  return r?.host ?? null;
}

/** The merge's own build timestamp (staleness display). */
export function mergedAt(db: Database): string | null {
  const r = db.query("SELECT value FROM merged_meta WHERE key = 'merged_at'").get() as {
    value: string;
  } | null;
  return r?.value ?? null;
}

/**
 * Sources for a merge run on this Host: every replica under `replicasRoot` (skipping a replica
 * of this Host itself), then the local data dir. Replica dir names ARE the Host names —
 * replicate.py keys its destination by the source machine's LocalHostName.
 */
export function discoverSources(localDir: string, localHost: string, replicasRoot: string): MergeSource[] {
  const sources: MergeSource[] = [];
  if (existsSync(replicasRoot)) {
    for (const name of readdirSync(replicasRoot).sort()) {
      if (name.toLowerCase() === localHost.toLowerCase()) continue; // never merge self twice
      const dir = join(replicasRoot, name, "claude-sessions");
      if (existsSync(dir)) sources.push({ host: name, dir });
    }
  }
  sources.push({ host: localHost, dir: localDir });
  return sources;
}
