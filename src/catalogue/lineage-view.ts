import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { ensureDataDir, CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { openCatalogue } from "./db.ts";
import { sessionsForIdentity } from "./identities.ts";
import { openIndex } from "../index/schema.ts";
import { sessionById } from "../index/index.ts";
import { humanText } from "../parse.ts";
import { openSessionIds } from "../cmux/liveness.ts";
import { formatCost } from "../cost.ts";
import { formatAge } from "../store.ts";

/**
 * Lineage view: `ccs identity lineage <key>` — bodies in succession order, with optional
 * full-text search across their transcripts. Under ADR-0089 a durable identity accumulates
 * session bodies over time; this view answers "what did all my bodies say?" without opening
 * each transcript by hand.
 *
 * Separate from `lineage.ts` (which is the compose-predecessors HELPER used by hooks for
 * rehydration). This one is the CLI-facing view. Shares humanText + open-session semantics.
 *
 * Salvaged from origin/master 6a91202 (which used a `role` axis; we use `identity_key`).
 */

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
  sessionId,
  title: null,
  firstTs: null,
  lastTs: null,
  msgCount: 0,
  costUSD: 0,
  path: null,
});

/** The identity's session bodies joined against the Index (title/dates/cost/transcript path). */
function bodiesOfIdentity(identityKey: string): IndexedBody[] {
  const cat = openCatalogue(CATALOGUE_PATH());
  let ids: string[];
  try {
    ids = sessionsForIdentity(cat, identityKey);
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
        ? {
            sessionId,
            title: r.title,
            firstTs: r.firstTs,
            lastTs: r.lastTs,
            msgCount: r.msgCount,
            costUSD: r.costUSD,
            path: r.path,
          }
        : unindexed(sessionId);
    });
  } finally {
    db.close();
  }
}

const day = (ts: string | null): string => (ts ? ts.slice(0, 10) : "?");

/**
 * `ccs identity lineage <key> [--search <query>]` — bodies in succession order,
 * optionally searched across their transcripts.
 */
export async function identityLineage(
  identityKey: string | undefined,
  searchQuery: string | undefined,
): Promise<number> {
  if (!identityKey || !identityKey.trim()) {
    console.error('usage: ccs identity lineage <identity_key> [--search "<query>"]');
    return 1;
  }
  ensureDataDir();
  const key = identityKey.trim();
  const bodies = successionOrder(bodiesOfIdentity(key));
  if (bodies.length === 0) {
    console.log(`No session bodies attached to identity ${key}.`);
    return 0;
  }
  const open = openSessionIds();

  console.log(
    `identity ${key} — ${bodies.length} bod${bodies.length === 1 ? "y" : "ies"} in succession:`,
  );
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
      console.log(
        `  ${i + 1}. ${b.sessionId.slice(0, 8)}… ${b.title ?? ""}  (transcript unreadable — not searched)`,
      );
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
