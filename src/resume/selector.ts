import type { Database } from "bun:sqlite";
import {
  sessionsForCluster,
  sessionsForRole,
  sessionsForPr,
  sessionsForGusWork,
  sessionsForEpic,
  sessionsForKey,
  getRow,
} from "../catalogue/db.ts";
import { sessionById } from "../index/index.ts";
import { allGroupings } from "../state/groupings.ts";

/**
 * Resolve a resume SELECTOR into a set of session ids. A selector is "anything that identifies a
 * session or a group of them" (Milad): a session id, a PR (`#123` or `repo#123`), a GUS work item
 * (`W-1234567`), an epic shortname, a role, or a cluster. One string in → zero-or-more ids out;
 * the caller resumes them (a single id → resume-session semantics, multiple → cluster semantics
 * with one-live-worker-per-work-unit dedup).
 *
 * The kind is INFERRED from the token's shape when unambiguous, and otherwise probed against each
 * axis in a fixed, documented order — so resolution is deterministic (no "did it mean a role or a
 * cluster?" guessing that changes with data). `--role`/`--pr`/… flags pin the axis explicitly and
 * skip inference.
 */

export type SelectorKind =
  | "session-id"
  | "pr"
  | "gus-work"
  | "epic"
  | "role"
  | "cluster"
  | "key";

export interface SelectorResult {
  kind: SelectorKind;
  /** Human label for what matched, e.g. `role "control"` or `PR heroku/dashboard#123`. */
  label: string;
  sessionIds: string[];
}

/** A W-number: `W-` followed by digits (GUS work item). */
const GUS_RE = /^W-\d+$/i;
/** A PR ref: `#123` (number only) or `owner/repo#123`. */
const PR_RE = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;
/** A UUID (session id / resume id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an epic shortname (or exact grouping id) to its grouping id, within a cluster if given
 * else across all known clusters. Shortname match is case-insensitive. Returns the epic_id used on
 * rows (the grouping key), or null if nothing matches.
 */
function groupingIdForShortName(db: Database, token: string, cluster?: string): string | null {
  const clusters = cluster ? [cluster] : clustersInPlay(db);
  const lc = token.toLowerCase();
  for (const c of clusters) {
    const groupings = allGroupings(c);
    for (const [id, g] of Object.entries(groupings)) {
      if (id.toLowerCase() === lc) return id;
      if (g.shortName && g.shortName.toLowerCase() === lc) return id;
      if (g.label && g.label.toLowerCase() === lc) return id;
    }
  }
  return null;
}

/** Distinct clusters that appear on catalogue rows (so epic lookup needn't be told the cluster). */
function clustersInPlay(db: Database): string[] {
  return (
    db.query("SELECT DISTINCT cluster FROM catalogue WHERE cluster IS NOT NULL").all() as {
      cluster: string;
    }[]
  ).map((r) => r.cluster);
}

/** Is this token a known cluster (some row carries it as `cluster`)? */
function isCluster(db: Database, token: string): boolean {
  return sessionsForCluster(db, token).length > 0;
}

export interface ResolveOpts {
  /** Pin the axis explicitly (from --role/--pr/--gus/--epic/--cluster). Skips shape inference. */
  pin?: SelectorKind;
  /** Constrain epic shortname / disambiguation to one cluster. */
  cluster?: string;
}

/**
 * Resolve a selector token to a SelectorResult. `indexDb` is consulted only to confirm a bare
 * UUID is a real (indexed) session; every other axis is a catalogue query.
 */
export function resolveSelector(
  catalogueDb: Database,
  indexDb: Database,
  token: string,
  opts: ResolveOpts = {},
): SelectorResult | null {
  const pin = opts.pin;

  // Explicit pins first — no inference.
  if (pin === "role") return { kind: "role", label: `role "${token}"`, sessionIds: sessionsForRole(catalogueDb, token) };
  if (pin === "cluster") return { kind: "cluster", label: `cluster "${token}"`, sessionIds: sessionsForCluster(catalogueDb, token) };
  if (pin === "gus-work") return { kind: "gus-work", label: `work item ${token}`, sessionIds: sessionsForGusWork(catalogueDb, token) };
  if (pin === "key") return { kind: "key", label: `key "${token}"`, sessionIds: sessionsForKey(catalogueDb, token) };
  if (pin === "epic") {
    const id = groupingIdForShortName(catalogueDb, token, opts.cluster);
    return { kind: "epic", label: `epic "${token}"`, sessionIds: id ? sessionsForEpic(catalogueDb, id) : [] };
  }
  if (pin === "pr") {
    const m = token.match(PR_RE);
    if (!m) return null;
    const [, repo, num] = m;
    return { kind: "pr", label: `PR ${repo ? repo + "#" : "#"}${num}`, sessionIds: sessionsForPr(catalogueDb, Number(num), repo) };
  }

  // Shape inference, most-specific shape first.
  if (UUID_RE.test(token)) {
    // A UUID is a session id (or resume id). Confirm it's indexed if we can; either way return it
    // so the caller can try (a just-minted session may not be indexed yet — resume-session handles
    // that). An index probe failure must never block resolving a literal id.
    let indexedId: string | null = null;
    try {
      indexedId = sessionById(indexDb, token)?.sessionId ?? null;
    } catch {
      indexedId = null;
    }
    return { kind: "session-id", label: `session ${token.slice(0, 8)}…`, sessionIds: [indexedId ?? token] };
  }
  if (GUS_RE.test(token)) {
    return { kind: "gus-work", label: `work item ${token.toUpperCase()}`, sessionIds: sessionsForGusWork(catalogueDb, token.toUpperCase()) };
  }
  const pr = token.match(PR_RE);
  if (pr) {
    const [, repo, num] = pr;
    return { kind: "pr", label: `PR ${repo ? repo + "#" : "#"}${num}`, sessionIds: sessionsForPr(catalogueDb, Number(num), repo) };
  }

  // Ambiguous bare word: probe axes in a fixed order — cluster, role, epic. First non-empty wins.
  if (isCluster(catalogueDb, token)) {
    return { kind: "cluster", label: `cluster "${token}"`, sessionIds: sessionsForCluster(catalogueDb, token) };
  }
  const byRole = sessionsForRole(catalogueDb, token);
  if (byRole.length > 0) return { kind: "role", label: `role "${token}"`, sessionIds: byRole };
  const groupingId = groupingIdForShortName(catalogueDb, token, opts.cluster);
  if (groupingId) return { kind: "epic", label: `epic "${token}"`, sessionIds: sessionsForEpic(catalogueDb, groupingId) };

  return null; // nothing matched any axis
}
