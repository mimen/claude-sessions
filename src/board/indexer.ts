import { statSync } from "node:fs";
import { boardPath, readBoard } from "./paths.ts";
import type { Board, BoardRow } from "./types.ts";
import { openCatalogue, identityKeyOf, getRow } from "../catalogue/db.ts";
import { CATALOGUE_PATH } from "../paths.ts";

export interface BoardIndex {
  byIdentity(identity: string): BoardRow | null;
  bySession(sessionId: string): { identity: string; row: BoardRow } | null;
  rows(): BoardRow[];
  refresh(): void;
}

interface CacheEntry {
  board: Board;
  identityMap: Map<string, BoardRow>;
  sessionMap: Map<string, string>;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

function buildMaps(board: Board): { identityMap: Map<string, BoardRow>; sessionMap: Map<string, string> } {
  const identityMap = new Map<string, BoardRow>();
  const sessionMap = new Map<string, string>();
  for (const row of board.rows) {
    identityMap.set(row.identity, row);
    for (const s of row.sessions) {
      sessionMap.set(s.sessionId, row.identity);
    }
  }
  return { identityMap, sessionMap };
}

function loadOrRefresh(cluster: string, force: boolean): CacheEntry | null {
  const path = boardPath(cluster);
  let mtime = 0;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const cached = cache.get(cluster);
  if (!force && cached && cached.mtime === mtime) return cached;
  const board = readBoard(cluster);
  if (!board) return null;
  const { identityMap, sessionMap } = buildMaps(board);
  const entry: CacheEntry = { board, identityMap, sessionMap, mtime };
  cache.set(cluster, entry);
  return entry;
}

export function boardIndex(cluster: string): BoardIndex {
  return {
    byIdentity(identity: string): BoardRow | null {
      const entry = loadOrRefresh(cluster, false);
      return entry?.identityMap.get(identity) ?? null;
    },
    bySession(sessionId: string): { identity: string; row: BoardRow } | null {
      const entry = loadOrRefresh(cluster, false);
      if (!entry) return null;
      const identity = entry.sessionMap.get(sessionId);
      if (!identity) {
        const db = openCatalogue(CATALOGUE_PATH());
        const catRow = getRow(db, sessionId);
        const resolvedIdentity = catRow ? identityKeyOf(catRow) : null;
        if (!resolvedIdentity) return null;
        const row = entry.identityMap.get(resolvedIdentity);
        return row ? { identity: resolvedIdentity, row } : null;
      }
      const row = entry.identityMap.get(identity);
      return row ? { identity, row } : null;
    },
    rows(): BoardRow[] {
      const entry = loadOrRefresh(cluster, false);
      return entry?.board.rows ?? [];
    },
    refresh(): void {
      loadOrRefresh(cluster, true);
    },
  };
}
