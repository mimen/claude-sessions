import { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { markT3Associated } from "../catalogue/db-mutations.ts";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { CLAUDE_PROVIDER_INSTANCE_ID } from "../catalogue-service/protocol.ts";
import { CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { log } from "../logger.ts";
import {
  productionT3AttachmentStatusClient,
  type T3AttachmentStatus,
  type T3AttachmentStatusClient,
} from "./status.ts";

interface T3IndexRow {
  readonly sessionId: string;
  readonly resumeId: string;
  readonly host: string;
  readonly cwd: string;
}

export interface T3AssociationMatch {
  readonly sessionId: string;
  readonly resumeId: string;
}

export interface T3AssociationMatchResult {
  readonly matches: readonly T3AssociationMatch[];
  readonly ambiguous: number;
}

export interface T3AssociationSyncResult {
  readonly status: "synced" | "unavailable" | "index-unreadable" | "catalogue-unreadable";
  readonly observed: number;
  readonly tagged: number;
  readonly ambiguous: number;
  readonly conflicts: number;
}

export interface T3AssociationSyncOptions {
  readonly statusClient?: T3AttachmentStatusClient;
  readonly indexPath?: string;
  readonly cataloguePath?: string;
  readonly localT3StatePath?: string;
  readonly now?: () => Date;
  readonly resolveCwd?: (cwd: string) => string;
  readonly markAssociation?: typeof markT3Associated;
  readonly logger?: Pick<typeof log, "warn">;
}

function rowsForIdentity(
  rows: readonly T3IndexRow[],
  attachments: readonly T3AttachmentStatus[],
  field: "resumeId" | "sessionId",
  resolveCwd: (cwd: string) => string,
): Set<T3IndexRow> {
  const candidates = new Set<T3IndexRow>();
  for (const attachment of attachments) {
    for (const row of rows) {
      if (row.host !== attachment.localSourceHost || row[field] !== attachment.nativeSessionId) continue;
      try {
        if (resolveCwd(row.cwd) === attachment.sourceCwd) candidates.add(row);
      } catch {
        // A vanished source path cannot be joined without weakening the durable identity.
      }
    }
  }
  return candidates;
}

/**
 * Resolve T3 attachments to canonical index rows. Resume aliases have priority; filename ids are a
 * fallback only when no resume alias matches. Any ambiguity is skipped because the resulting mark is
 * deliberately permanent.
 */
export function matchT3Associations(
  rows: readonly T3IndexRow[],
  attachments: readonly T3AttachmentStatus[],
  resolveCwd: (cwd: string) => string = realpathSync,
): T3AssociationMatchResult {
  const eligible = attachments.filter((attachment) =>
    attachment.providerInstanceId === CLAUDE_PROVIDER_INSTANCE_ID
  );
  const identities = new Map<string, T3AttachmentStatus[]>();
  for (const attachment of eligible) {
    const key = `${attachment.localSourceHost}\0${attachment.nativeSessionId}`;
    const group = identities.get(key) ?? [];
    group.push(attachment);
    identities.set(key, group);
  }

  const matches = new Map<string, T3AssociationMatch>();
  let ambiguous = 0;
  for (const group of identities.values()) {
    const resumeMatches = rowsForIdentity(rows, group, "resumeId", resolveCwd);
    const candidates = resumeMatches.size > 0
      ? resumeMatches
      : rowsForIdentity(rows, group, "sessionId", resolveCwd);
    if (candidates.size !== 1) {
      if (candidates.size > 1) ambiguous += 1;
      continue;
    }
    const row = [...candidates][0];
    if (!row) continue;
    matches.set(row.sessionId, { sessionId: row.sessionId, resumeId: row.resumeId });
  }
  return { matches: [...matches.values()], ambiguous };
}

/** Local-database fallback when the optional `t3` CLI is not installed. UUIDs remain ambiguity-safe. */
export function matchT3SessionIds(
  rows: readonly T3IndexRow[],
  nativeSessionIds: readonly string[],
): T3AssociationMatchResult {
  const matches = new Map<string, T3AssociationMatch>();
  let ambiguous = 0;
  for (const nativeSessionId of new Set(nativeSessionIds)) {
    const resumeMatches = rows.filter((row) => row.resumeId === nativeSessionId);
    const candidates = resumeMatches.length > 0
      ? resumeMatches
      : rows.filter((row) => row.sessionId === nativeSessionId);
    if (candidates.length !== 1) {
      if (candidates.length > 1) ambiguous += 1;
      continue;
    }
    const row = candidates[0];
    if (row) matches.set(row.sessionId, { sessionId: row.sessionId, resumeId: row.resumeId });
  }
  return { matches: [...matches.values()], ambiguous };
}

function readLocalT3SessionIds(path: string): string[] {
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    const rows = db.query(
      `SELECT resume_cursor_json
         FROM provider_session_runtime
        WHERE provider_name = 'claudeAgent'
          AND resume_cursor_json IS NOT NULL`,
    ).all() as Array<{ resume_cursor_json: string }>;
    const ids = new Set<string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.resume_cursor_json) as { resume?: string };
        if (typeof parsed.resume === "string" && parsed.resume.trim() !== "") ids.add(parsed.resume);
      } catch {
        // One malformed private T3 row does not invalidate the other positive observations.
      }
    }
    return [...ids];
  } finally {
    db.close();
  }
}

function readIndexRows(indexPath: string): T3IndexRow[] {
  const db = new Database(indexPath, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    const rows = db.query(
      `SELECT session_id, COALESCE(resume_id, session_id) AS resume_id, host, cwd
         FROM sessions
        WHERE is_subagent = 0
          AND cwd IS NOT NULL
          AND TRIM(cwd) <> ''`,
    ).all() as Array<{
      session_id: string;
      resume_id: string;
      host: string;
      cwd: string;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      resumeId: row.resume_id,
      host: row.host,
      cwd: row.cwd,
    }));
  } finally {
    db.close();
  }
}

/** Observe positive T3 evidence once. Failures and empty snapshots never clear prior marks. */
export async function syncT3Associations(
  options: T3AssociationSyncOptions = {},
): Promise<T3AssociationSyncResult> {
  const logger = options.logger ?? log;
  const snapshot = await (options.statusClient ?? productionT3AttachmentStatusClient).snapshot();
  let localSessionIds: string[] = [];
  try {
    localSessionIds = readLocalT3SessionIds(
      options.localT3StatePath ?? join(homedir(), ".t3", "userdata", "state.sqlite"),
    );
  } catch (error) {
    if (snapshot.kind === "failure") {
      logger.warn("T3 association sync could not read T3 local state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (snapshot.kind === "failure" && localSessionIds.length === 0) {
    return { status: "unavailable", observed: 0, tagged: 0, ambiguous: 0, conflicts: 0 };
  }

  let rows: T3IndexRow[];
  try {
    rows = readIndexRows(options.indexPath ?? DB_PATH());
  } catch (error) {
    logger.warn("T3 association sync could not read the session index", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "index-unreadable", observed: 0, tagged: 0, ambiguous: 0, conflicts: 0 };
  }

  const attachmentMatches = snapshot.kind === "snapshot"
    ? matchT3Associations(rows, snapshot.snapshot.attachments, options.resolveCwd)
    : { matches: [], ambiguous: 0 };
  const localMatches = matchT3SessionIds(rows, localSessionIds);
  const mergedMatches = new Map<string, T3AssociationMatch>();
  for (const match of [...attachmentMatches.matches, ...localMatches.matches]) {
    mergedMatches.set(match.sessionId, match);
  }
  const resolved: T3AssociationMatchResult = {
    matches: [...mergedMatches.values()],
    ambiguous: attachmentMatches.ambiguous + localMatches.ambiguous,
  };
  if (resolved.ambiguous > 0) {
    logger.warn("T3 association sync skipped ambiguous source identities", {
      ambiguous: resolved.ambiguous,
    });
  }

  let db: Database;
  try {
    db = openCatalogue(options.cataloguePath ?? CATALOGUE_PATH(), { materialize: false });
  } catch (error) {
    logger.warn("T3 association sync could not open the catalogue", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "catalogue-unreadable",
      observed: resolved.matches.length,
      tagged: 0,
      ambiguous: resolved.ambiguous,
      conflicts: 0,
    };
  }

  let tagged = 0;
  let conflicts = 0;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const markAssociation = options.markAssociation ?? markT3Associated;
  try {
    db.transaction(() => {
      for (const match of resolved.matches) {
        const result = markAssociation(db, match.sessionId, match.resumeId, now);
        if (result === "changed") tagged += 1;
        if (result === "conflict" || result === "not-found" || result === "ambiguous") conflicts += 1;
      }
    })();
  } catch (error) {
    logger.warn("T3 association sync could not write the catalogue", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "catalogue-unreadable",
      observed: resolved.matches.length,
      tagged: 0,
      ambiguous: resolved.ambiguous,
      conflicts: 0,
    };
  } finally {
    db.close();
  }
  if (conflicts > 0) {
    logger.warn("T3 association sync skipped catalogue alias conflicts", { conflicts });
  }
  return {
    status: "synced",
    observed: resolved.matches.length,
    tagged,
    ambiguous: resolved.ambiguous,
    conflicts,
  };
}
