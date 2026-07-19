import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { ensureDataDir, CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { sessionsForRole, openCatalogue } from "./db.ts";
import { openIndex } from "../index/schema.ts";
import { sessionById } from "../index/index.ts";
import { humanText } from "../parse.ts";
import { openSessionIds } from "../cmux/liveness.ts";
import { formatCost } from "../cost.ts";
import { formatAge } from "../store.ts";
import type { Database } from "bun:sqlite";
import type { CatalogueRow } from "./db.ts";
import { getAll, deriveKey } from "./db.ts";

/**
 * Identity lineage (ADR-0038): a durable identity (responsibility) may have had SEVERAL session
 * embodiments over time. A fresh embodiment rehydrates from its predecessors — reviewing what
 * past bodies did/tried/concluded — instead of rediscovering it. This resolves an identity to
 * its ordered prior embodiments + each one's transcript path.
 *
 * The identity KEY is the responsibility (ADR-0026/0030): a fleet worker's work-unit
 * (pr:repo#num / gus:W-…), or a core role's role name. Grouping on that key is what makes the
 * lineage findable without a stored predecessor pointer — session id is disposable, the
 * responsibility is durable.
 */

/** The responsibility key a row belongs to. ADR-D1 (2026-07-14): ccs is the single source of
 * truth. On stored rows the `key` column is authoritative (auto-derived on every mutation via
 * `refreshDerivedKey`); this function falls back to computing from the row's identity-relevant
 * columns for callers that pass a pure/synthetic row without persistence. */
export function identityKey(row: CatalogueRow): string | null {
  return row.key ?? deriveKey(row);
}

export interface Embodiment {
  sessionId: string;
  /** Absolute path to the session's transcript (.jsonl), or null if not indexed. */
  transcriptPath: string | null;
  /** Last-activity timestamp for ordering (ISO), or null. */
  lastTs: string | null;
  completed: boolean;
  archived: boolean;
}

/**
 * The predecessors of `sessionId` within its identity: every OTHER session sharing its
 * responsibility key, oldest → newest. `sessionId` itself is excluded (it's the current
 * embodiment). Returns [] if the row isn't keyed or has no siblings.
 *
 * `transcriptPaths` maps session_id → indexed transcript path (the caller reads it from the
 * index; passed in so this stays a pure join over already-gathered facts, testable without I/O).
 */
export function predecessorsOf(
  rows: ReadonlyMap<string, CatalogueRow>,
  sessionId: string,
  transcriptPaths: ReadonlyMap<string, { path: string | null; lastTs: string | null }>,
): Embodiment[] {
  const self = rows.get(sessionId);
  if (!self) return [];
  const key = identityKey(self);
  if (!key) return [];

  const sibs: Embodiment[] = [];
  for (const [sid, row] of rows) {
    if (sid === sessionId) continue; // exclude self
    if (identityKey(row) !== key) continue;
    const t = transcriptPaths.get(sid) ?? { path: null, lastTs: null };
    sibs.push({
      sessionId: sid,
      transcriptPath: t.path,
      lastTs: t.lastTs,
      completed: row.completed,
      archived: row.archived,
    });
  }
  // oldest → newest by lastTs (nulls last), so the fresh embodiment reads history in order.
  // sessionId is the stable final tie-break: equal (or both-null) lastTs must not depend on the
  // JS engine's unstable-sort behavior, or lineage order flips between runtimes (ADR determinism).
  sibs.sort((a, b) => {
    if (a.lastTs && b.lastTs) {
      if (a.lastTs !== b.lastTs) return a.lastTs < b.lastTs ? -1 : 1;
      return a.sessionId.localeCompare(b.sessionId);
    }
    if (a.lastTs) return -1;
    if (b.lastTs) return 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return sibs;
}

/** DB-backed resolver: gather the catalogue rows + index transcript paths, run the pure join. */
export function resolvePredecessors(catalogue: Database, index: Database, sessionId: string): Embodiment[] {
  const rows = getAll(catalogue);
  const paths = new Map<string, { path: string | null; lastTs: string | null }>();
  try {
    const q = index.query("SELECT session_id, path, last_ts FROM sessions");
    for (const r of q.all() as Array<{ session_id: string; path: string | null; last_ts: string | null }>) {
      paths.set(r.session_id, { path: r.path, lastTs: r.last_ts });
    }
  } catch {
    /* index unreadable → transcripts unknown; predecessors still list by id (fail-open) */
  }
  return predecessorsOf(rows, sessionId, paths);
}


/** One body in a lineage, as much of it as the Index knows (unindexed bodies keep nulls). */
export interface LineageBody {
  readonly sessionId: string;
  readonly firstTs: string | null;
}

/** Succession order: first activity ascending; unindexed bodies last; ties by sessionId. */
export function successionOrder<T extends LineageBody>(bodies: readonly T[]): T[] {
  return bodies.slice().sort((a, b) => {
    if (a.firstTs === null && b.firstTs === null) return a.sessionId.localeCompare(b.sessionId);
    if (a.firstTs === null) return 1;
    if (b.firstTs === null) return -1;
    return a.firstTs.localeCompare(b.firstTs) || a.sessionId.localeCompare(b.sessionId);
  });
}

/** A transcript line that matched a lineage search. */
export interface TranscriptMatch {
  readonly role: "user" | "assistant";
  readonly timestamp: string | null;
  readonly snippet: string;
}

const SNIPPET_RADIUS = 60;

/** A bounded, single-line window around the match in a (possibly huge) prose blob. */
function snippetAround(text: string, matchIdx: number, matchLen: number): string {
  const start = Math.max(0, matchIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchIdx + matchLen + SNIPPET_RADIUS);
  const clipped = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${clipped}${end < text.length ? "…" : ""}`;
}

/** Case-insensitive literal matcher — regex `i` so the match index lands in the ORIGINAL text
 *  (a lowercased copy can change length under Unicode case folding and misalign the snippet). */
function literalMatcher(query: string): RegExp {
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

/** Whether a needle can be prefiltered against the RAW JSONL line: JSON never escapes these
 *  characters, so any prose match must also appear literally in the encoded line. */
function rawPrefilterSafe(query: string): boolean {
  return /^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/.test(query); // printable ASCII minus `"` and `\`
}

/**
 * Stream one transcript and return prose lines matching the query (case-insensitive literal),
 * capped. Corrupt lines are skipped; an unreadable/vanished file returns null so the caller can
 * say "couldn't search this body" instead of a false "(no matches)".
 */
export async function searchTranscript(
  path: string,
  query: string,
  cap: number,
): Promise<TranscriptMatch[] | null> {
  if (!query) return [];
  const matcher = literalMatcher(query);
  const prefilter = rawPrefilterSafe(query) ? query.toLowerCase() : null;
  const matches: TranscriptMatch[] = [];
  try {
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (matches.length >= cap) break;
      if (!line.trim()) continue;
      // Transcripts reach tens of MB — skip JSON.parse on lines that can't possibly match.
      if (prefilter && !line.toLowerCase().includes(prefilter)) continue;
      let obj: {
        type?: string;
        timestamp?: string;
        message?: { content?: unknown };
      };
      try {
        obj = JSON.parse(line) as typeof obj;
      } catch {
        continue;
      }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      const prose = humanText(obj.message?.content);
      const m = matcher.exec(prose);
      if (!m) continue;
      matches.push({
        role: obj.type,
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : null,
        snippet: snippetAround(prose, m.index, m[0].length),
      });
    }
  } catch {
    return null; // unreadable / vanished file — distinct from "no matches"
  }
  return matches;
}

const MATCHES_PER_BODY = 5;

interface IndexedBody extends LineageBody {
  readonly title: string | null;
  readonly lastTs: string | null;
  readonly msgCount: number;
  readonly costUSD: number;
  readonly path: string | null;
}

const unindexed = (sessionId: string): IndexedBody => ({
  sessionId, title: null, firstTs: null, lastTs: null, msgCount: 0, costUSD: 0, path: null,
});

/** The role's bodies joined against the Index (title/dates/cost/transcript path). */
function bodiesOf(role: string): IndexedBody[] {
  const cat = openCatalogue(CATALOGUE_PATH());
  let ids: string[];
  try {
    ids = sessionsForRole(cat, role);
  } finally {
    cat.close();
  }
  if (ids.length === 0) return [];
  if (!existsSync(DB_PATH())) return ids.map(unindexed);
  const db = openIndex(DB_PATH());
  try {
    return ids.map((sessionId) => {
      const r = sessionById(db, sessionId);
      return r
        ? { sessionId, title: r.title, firstTs: r.firstTs, lastTs: r.lastTs, msgCount: r.msgCount, costUSD: r.costUSD, path: r.path }
        : unindexed(sessionId);
    });
  } finally {
    db.close();
  }
}

const day = (ts: string | null): string => (ts ? ts.slice(0, 10) : "?");

/** `ccs lineage <role> [--search <query>]` — bodies in succession order, optionally searched. */
export async function lineage(role: string | undefined, searchQuery: string | undefined): Promise<number> {
  if (!role || !role.trim()) {
    console.error('usage: ccs lineage <role> [--search "<query>"]');
    return 1;
  }
  ensureDataDir();
  const name = role.trim();
  const bodies = successionOrder(bodiesOf(name));
  if (bodies.length === 0) {
    console.log(`No bodies for role ${name}. Attach one with \`ccs role <id|.> ${name}\`.`);
    return 0;
  }
  const open = openSessionIds();

  console.log(`role ${name} — ${bodies.length} bod${bodies.length === 1 ? "y" : "ies"} in succession:`);
  for (const [i, b] of bodies.entries()) {
    const live = open.has(b.sessionId) ? " ●" : "";
    const title = b.title ?? "(not indexed on this host)";
    const detail = b.path
      ? `  ${day(b.firstTs)} → ${day(b.lastTs)} (${formatAge(b.lastTs)})  ${b.msgCount}m  ${formatCost(b.costUSD) || "$0"}`
      : "";
    console.log(`${i + 1}. ${b.sessionId.slice(0, 8)}… ${title}${detail}${live}`);
  }

  const query = searchQuery?.trim();
  if (!query) return 0;
  console.log(`\nsearch "${query}" across the lineage:`);
  let total = 0;
  for (const [i, b] of bodies.entries()) {
    if (!b.path) continue;
    const matches = await searchTranscript(b.path, query, MATCHES_PER_BODY);
    if (matches === null) {
      console.log(`  ${i + 1}. ${b.sessionId.slice(0, 8)}… ${b.title ?? ""}  (transcript unreadable — not searched)`);
      total++; // surfaced something; don't also print "(no matches)"
      continue;
    }
    if (matches.length === 0) continue;
    total += matches.length;
    console.log(`  ${i + 1}. ${b.sessionId.slice(0, 8)}… ${b.title ?? ""}`);
    for (const m of matches) {
      console.log(`     ${day(m.timestamp)} ${m.role}: ${m.snippet}`);
    }
  }
  if (total === 0) console.log("  (no matches)");
  return 0;
}
