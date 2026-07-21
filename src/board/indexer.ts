import { statSync } from "node:fs";
import { boardPath, readBoard } from "./paths.ts";
import type { Board, BoardRow } from "./types.ts";
import { openCatalogue, identityKeyOf, getRow } from "../catalogue/db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";

export interface BoardIndex {
  byIdentity(identity: string): BoardRow | null;
  bySession(sessionId: string): { identity: string; row: BoardRow } | null;
  rows(): BoardRow[];
  refresh(): void;
}

interface FileSignature {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

interface CacheEntry {
  board: Board;
  identityMap: Map<string, BoardRow>;
  sessionMap: Map<string, string>;
  signature: FileSignature;
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

function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.birthtimeNs === b.birthtimeNs;
}

function loadOrRefresh(cluster: string, force: boolean): CacheEntry | null {
  const path = boardPath(cluster);
  let signature: FileSignature;
  try {
    const stat = statSync(path, { bigint: true });
    signature = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      birthtimeNs: stat.birthtimeNs,
    };
  } catch {
    return null;
  }
  const cached = cache.get(path);
  if (!force && cached && sameSignature(cached.signature, signature)) return cached;
  const board = readBoard(cluster);
  if (!board) return null;
  const { identityMap, sessionMap } = buildMaps(board);
  const entry: CacheEntry = { board, identityMap, sessionMap, signature };
  cache.set(path, entry);
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
        try {
          ensureDataDir();
          const db = openCatalogue(CATALOGUE_PATH());
          const catRow = getRow(db, sessionId);
          const resolvedIdentity = catRow ? identityKeyOf(catRow) : null;
          if (!resolvedIdentity) return null;
          const row = entry.identityMap.get(resolvedIdentity);
          return row ? { identity: resolvedIdentity, row } : null;
        } catch {
          return null;
        }
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
