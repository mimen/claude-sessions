import type { Bridge, SurfaceLocation } from "../cmux/bridge.ts";

/**
 * The sidebar's single authority on session identity and short-horizon liveness.
 *
 * Before this existed, two components answered "which ids name the same session" from different
 * sources: projection resolved through the catalogue's canonical map while the action endpoints
 * resolved through the index's sessionId/resumeId columns. The two sources learn about a resume
 * at different times, so in the window where they disagreed the sidebar would display a row under
 * an id its own open endpoint could not resolve — a click that did nothing — or display the same
 * session twice under two ids, which doubles every per-row visual state the client paints.
 *
 * The ledger accretes identity from BOTH sources into one alias graph and answers for everyone.
 * Accretion is deliberate: a fact learned from either source persists for the process lifetime,
 * so a source that flaps (an index mid-rescan, an unreadable catalogue) cannot un-teach identity
 * it already taught.
 *
 * It also carries what the slow sources cannot know yet, bounded by TTL:
 *  - a resume the action layer just performed, so the row can be live before the hook store binds;
 *  - a close it just performed, so the row can stop being live before the hook store forgets;
 *  - the last active window cmux reported, so one degraded tree read (active pointer missing)
 *    cannot flip every window's selected workspace to "focused".
 */
export interface ResumeTarget {
  readonly workspaceRef: string;
  readonly windowRef: string | null;
}

export interface LivenessLedger {
  /** Feed the catalogue's alias→canonical map. Call on every catalogue read; cheap when unchanged. */
  observeCatalogue(canonicalSessionIds: ReadonlyMap<string, string>): void;
  /** Feed index rows' sessionId/resumeId pairs. Call on every index read. */
  observeIndex(sessions: Iterable<{ readonly sessionId: string; readonly resumeId: string }>): void;
  /**
   * Feed the tree's active-window pointer and get back the effective one: the value itself when
   * present, otherwise the last one that was. Null only before the first successful read.
   */
  observeActiveWindow(activeWindowId: string | null): string | null;

  /** Every id known to name the same session, the requested id included. */
  aliasesFor(sessionId: string): readonly string[];
  canonicalFor(sessionId: string): string;
  /** alias → canonical for every id the ledger has seen. Built fresh; do not retain across writes. */
  canonicalMap(): ReadonlyMap<string, string>;
  /** Locate a session's live surface trying every alias, not just the requested id. */
  locate(bridge: Bridge, sessionId: string): SurfaceLocation | null;

  /** Record a resume the action layer performed; clears any closed note for the same session. */
  noteResumed(sessionIds: readonly string[], target: ResumeTarget): void;
  recentResumeTarget(sessionIds: readonly string[]): ResumeTarget | null;
  /** All unexpired resume hints, keyed by canonical id. */
  activeResumeHints(): ReadonlyMap<string, ResumeTarget>;
  /** Record a close the action layer performed; clears any resume note for the same session. */
  noteClosed(sessionIds: readonly string[]): void;
  isRecentlyClosed(sessionId: string): boolean;

  /** Introspection for the debug endpoint; shape is for eyes, not for programs. */
  debugState(): Record<string, unknown>;
}

export interface LivenessLedgerOptions {
  readonly now?: () => number;
  /** How long a resume hint vouches for liveness the hook store has not confirmed. */
  readonly resumeHintTtlMs?: number;
  /** How long a close hint suppresses liveness the hook store has not retired. */
  readonly closedHintTtlMs?: number;
}

const RESUME_HINT_TTL_MS = 15_000;
const CLOSED_HINT_TTL_MS = 12_000;

export function createLivenessLedger(options: LivenessLedgerOptions = {}): LivenessLedger {
  const now = options.now ?? (() => Date.now());
  const resumeTtl = options.resumeHintTtlMs ?? RESUME_HINT_TTL_MS;
  const closedTtl = options.closedHintTtlMs ?? CLOSED_HINT_TTL_MS;

  // Union-find over session ids. Roots prefer catalogue-canonical ids so `canonicalFor` answers
  // with the id the catalogue (and therefore the projection) would use; among equals the lexical
  // minimum wins so the answer is deterministic regardless of observation order.
  const parent = new Map<string, string>();
  const catalogueCanonical = new Set<string>();
  /** Ids seen in the index's sessionId column — the row identity, preferred over resume aliases. */
  const indexPrimary = new Set<string>();

  function find(id: string): string {
    let root = id;
    while (true) {
      const up = parent.get(root);
      if (up === undefined || up === root) break;
      root = up;
    }
    // Path compression, done as a second walk so the first stays allocation-free.
    let walk = id;
    while (walk !== root) {
      const up = parent.get(walk)!;
      parent.set(walk, root);
      walk = up;
    }
    if (!parent.has(root)) parent.set(root, root);
    return root;
  }

  // Root preference decides which alias a row is displayed and addressed under. The catalogue's
  // canonical id wins where it has spoken; otherwise the index's own row identity (sessionId
  // column) beats a resume alias; lexical order settles what remains, so the answer never depends
  // on observation order.
  function rootRank(id: string): number {
    if (catalogueCanonical.has(id)) return 2;
    if (indexPrimary.has(id)) return 1;
    return 0;
  }

  function preferredRoot(a: string, b: string): string {
    const rankA = rootRank(a);
    const rankB = rootRank(b);
    if (rankA !== rankB) return rankA > rankB ? a : b;
    return a < b ? a : b;
  }

  // An id can become preferred AFTER its component already chose a root — the index taught the
  // pair before the catalogue named the canonical. Re-root so later observations still win the
  // rank they deserve; without this the answer would depend on which source spoke first.
  function promote(id: string): void {
    const root = find(id);
    if (root !== id && preferredRoot(id, root) === id) parent.set(root, id);
  }

  function union(a: string, b: string): void {
    if (!a || !b || a === b) return;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const winner = preferredRoot(rootA, rootB);
    const loser = winner === rootA ? rootB : rootA;
    parent.set(loser, winner);
  }

  function componentOf(id: string): string[] {
    const root = find(id);
    const members: string[] = [];
    for (const key of parent.keys()) {
      if (find(key) === root) members.push(key);
    }
    if (!members.includes(id)) members.push(id);
    return members;
  }

  // Hints, keyed by canonical id at write time. Reads re-canonicalize, so a hint written before
  // the graph learned an alias is still found through it afterwards.
  const resumeHints = new Map<string, { readonly until: number; readonly target: ResumeTarget }>();
  const closedHints = new Map<string, number>();
  let lastActiveWindowId: string | null = null;

  function sweep(): void {
    const current = now();
    for (const [key, hint] of resumeHints) if (hint.until <= current) resumeHints.delete(key);
    for (const [key, until] of closedHints) if (until <= current) closedHints.delete(key);
  }

  function canonicalKeys(sessionIds: readonly string[]): Set<string> {
    const keys = new Set<string>();
    for (const id of sessionIds) if (id) keys.add(find(id));
    return keys;
  }

  return {
    observeCatalogue(canonicalSessionIds) {
      for (const canonical of canonicalSessionIds.values()) {
        if (canonical) catalogueCanonical.add(canonical);
      }
      for (const [alias, canonical] of canonicalSessionIds) {
        union(alias, canonical);
        if (canonical) promote(canonical);
      }
    },

    observeIndex(sessions) {
      for (const session of sessions) {
        if (session.sessionId) indexPrimary.add(session.sessionId);
        union(session.sessionId, session.resumeId);
        if (session.sessionId) promote(session.sessionId);
      }
    },

    observeActiveWindow(activeWindowId) {
      if (activeWindowId !== null) lastActiveWindowId = activeWindowId;
      return lastActiveWindowId;
    },

    aliasesFor(sessionId) {
      return componentOf(sessionId);
    },

    canonicalFor(sessionId) {
      return find(sessionId);
    },

    canonicalMap() {
      const map = new Map<string, string>();
      for (const key of parent.keys()) map.set(key, find(key));
      return map;
    },

    locate(bridge, sessionId) {
      const direct = bridge.locateSession(sessionId);
      if (direct) return direct;
      for (const alias of componentOf(sessionId)) {
        if (alias === sessionId) continue;
        const location = bridge.locateSession(alias);
        if (location) return location;
      }
      return null;
    },

    noteResumed(sessionIds, target) {
      sweep();
      const until = now() + Math.max(0, resumeTtl);
      for (const key of canonicalKeys(sessionIds)) {
        resumeHints.set(key, { until, target });
        closedHints.delete(key);
      }
    },

    recentResumeTarget(sessionIds) {
      sweep();
      for (const key of canonicalKeys(sessionIds)) {
        const hint = resumeHints.get(key);
        if (hint) return hint.target;
      }
      return null;
    },

    activeResumeHints() {
      sweep();
      const map = new Map<string, ResumeTarget>();
      // Keys were canonical at write time; re-canonicalize in case the graph has since merged them.
      for (const [key, hint] of resumeHints) map.set(find(key), hint.target);
      return map;
    },

    noteClosed(sessionIds) {
      sweep();
      const until = now() + Math.max(0, closedTtl);
      for (const key of canonicalKeys(sessionIds)) {
        closedHints.set(key, until);
        resumeHints.delete(key);
      }
    },

    isRecentlyClosed(sessionId) {
      sweep();
      return closedHints.has(find(sessionId));
    },

    debugState() {
      sweep();
      const components = new Map<string, string[]>();
      for (const key of parent.keys()) {
        const root = find(key);
        const list = components.get(root) ?? [];
        list.push(key);
        components.set(root, list);
      }
      const multi = [...components.entries()]
        .filter(([, members]) => members.length > 1)
        .map(([root, members]) => ({ canonical: root, aliases: members.sort() }));
      return {
        knownIds: parent.size,
        aliasComponents: multi.length,
        components: multi,
        resumeHints: [...resumeHints.entries()].map(([id, hint]) => ({
          sessionId: id,
          workspaceRef: hint.target.workspaceRef,
          expiresInMs: Math.max(0, hint.until - now()),
        })),
        closedHints: [...closedHints.entries()].map(([id, until]) => ({
          sessionId: id,
          expiresInMs: Math.max(0, until - now()),
        })),
        lastActiveWindowId,
      };
    },
  };
}
