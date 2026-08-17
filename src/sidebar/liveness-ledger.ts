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
   * present, otherwise the last one that was — but only while that window still exists. Pass
   * `liveWindowIds` from a readable tree so a sticky pointer to a closed window is dropped
   * instead of filtering every workspace against a window that is gone. Null when nothing
   * current is known.
   */
  observeActiveWindow(
    activeWindowId: string | null,
    liveWindowIds?: ReadonlySet<string>,
  ): string | null;

  /** Every id known to name the same session, the requested id included. */
  aliasesFor(sessionId: string): readonly string[];
  canonicalFor(sessionId: string): string;
  /**
   * alias → canonical for every id the ledger has observed. Cached until the graph changes; the
   * returned map must be treated as immutable and not retained across writes.
   */
  canonicalMap(): ReadonlyMap<string, string>;
  /** Locate a session's live surface trying every alias, not just the requested id. */
  locate(bridge: Bridge, sessionId: string): SurfaceLocation | null;

  /** Record a resume the action layer performed; clears any closed note for the same session. */
  noteResumed(sessionIds: readonly string[], target: ResumeTarget): void;
  recentResumeTarget(sessionIds: readonly string[]): ResumeTarget | null;
  /** All unexpired resume hints, keyed by canonical id. */
  activeResumeHints(): ReadonlyMap<string, ResumeTarget>;
  /**
   * Record a close the action layer performed; clears any resume note for the same session.
   * `workspaceId` scopes the suppression to the workspace that was actually closed.
   */
  noteClosed(sessionIds: readonly string[], workspaceId?: string): void;
  /**
   * Whether a close hint should suppress this session's liveness. A hint records which workspace
   * was closed; a live binding observed in a DIFFERENT workspace is fresh truth (the session was
   * reopened elsewhere) and is not suppressed. Callers that have a binding pass its workspaceId.
   */
  isRecentlyClosed(sessionId: string, boundWorkspaceId?: string): boolean;

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

interface ResumeHint {
  readonly until: number;
  readonly writtenAt: number;
  readonly target: ResumeTarget;
}

interface ClosedHint {
  readonly until: number;
  readonly writtenAt: number;
  readonly workspaceId: string | null;
}

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

  // Structure version: bumped by every registration, union, and promotion. Guards the
  // canonicalMap cache; path compression rewrites edges without changing any answer, so it
  // deliberately does not bump.
  let generation = 0;

  // Pure: an id the ledger has never observed resolves to itself and is NOT retained. Reads are
  // reachable from HTTP with caller-supplied ids, and a lookup must not grow the graph — only
  // observations (register below) do.
  function find(id: string): string {
    let root = id;
    // Bounded ascent: this runs on the request path of a long-lived daemon, so a future bug that
    // corrupts the parent map into a cycle must degrade to a wrong answer, never to a spin that
    // wedges the process.
    let steps = 0;
    while (true) {
      const up = parent.get(root);
      if (up === undefined || up === root) break;
      if (++steps > parent.size) return id;
      root = up;
    }
    // Path compression, done as a second walk so the first stays allocation-free.
    let walk = id;
    while (walk !== root) {
      const up = parent.get(walk)!;
      parent.set(walk, root);
      walk = up;
    }
    return root;
  }

  function register(id: string): void {
    if (id && !parent.has(id)) {
      parent.set(id, id);
      generation += 1;
    }
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
  // rank they deserve. The id must point at ITSELF before the old root points at it, or the two
  // form a cycle and every subsequent find() spins forever.
  function promote(id: string): void {
    const root = find(id);
    if (root === id || preferredRoot(id, root) !== id) return;
    parent.set(id, id);
    parent.set(root, id);
    generation += 1;
  }

  // The two sources assert different relations. A catalogue alias→canonical edge is the
  // catalogue saying "one session" — its own reader already refuses to alias two of its
  // canonical rows together, so the edge is trusted. An index sessionId→resumeId edge only says
  // "this transcript DESCENDS from that id": for a linear resume that coincides with identity,
  // for a fork it does not, and the index cannot tell the two apart. So an index edge never
  // merges two ids that are each a session in their own right — two catalogue-canonical rows,
  // or two indexed transcripts (fork siblings both descend from one parent; a resumed parent's
  // own transcript is also still indexed). The genuine-resume merge those guards defer is made
  // later by the catalogue edge, which is the authority on it. What an index edge still merges
  // is a dangling historical id — a resume ancestor with no row of its own anywhere.
  function union(a: string, b: string, source: "catalogue" | "index"): void {
    if (!a || !b) return;
    register(a);
    register(b);
    if (a === b) return;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    if (catalogueCanonical.has(rootA) && catalogueCanonical.has(rootB)) return;
    if (source === "index" && indexPrimary.has(rootA) && indexPrimary.has(rootB)) return;
    const winner = preferredRoot(rootA, rootB);
    const loser = winner === rootA ? rootB : rootA;
    parent.set(loser, winner);
    generation += 1;
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

  // Hints, keyed by the component root current at write time. sweep() re-keys them whenever the
  // graph has since chosen a different root, so alias-graph growth can neither orphan a hint
  // (reads look up the new root) nor resurrect one over a newer verdict for the same session.
  const resumeHints = new Map<string, ResumeHint>();
  const closedHints = new Map<string, ClosedHint>();
  let lastActiveWindowId: string | null = null;
  let cachedCanonicalMap: { generation: number; map: ReadonlyMap<string, string> } | null = null;

  function rekey<V>(map: Map<string, V>, merge: (a: V, b: V) => V): void {
    let moves: Array<[string, string, V]> | null = null;
    for (const [key, value] of map) {
      const root = find(key);
      if (root !== key) (moves ??= []).push([key, root, value]);
    }
    if (!moves) return;
    for (const [key, root, value] of moves) {
      map.delete(key);
      const existing = map.get(root);
      map.set(root, existing === undefined ? value : merge(existing, value));
    }
  }

  function sweep(): void {
    const current = now();
    for (const [key, hint] of resumeHints) if (hint.until <= current) resumeHints.delete(key);
    for (const [key, hint] of closedHints) if (hint.until <= current) closedHints.delete(key);
    rekey(resumeHints, (a, b) => (a.writtenAt >= b.writtenAt ? a : b));
    rekey(closedHints, (a, b) => (a.writtenAt >= b.writtenAt ? a : b));
    // Re-keying can land a resume hint and a close hint on the same root even though every write
    // clears its opposite — they were written under different roots that have since merged. The
    // newer write is the session's latest known state; a tie suppresses, which self-heals in one
    // close TTL either way.
    for (const [key, resume] of resumeHints) {
      const closed = closedHints.get(key);
      if (closed === undefined) continue;
      if (closed.writtenAt >= resume.writtenAt) resumeHints.delete(key);
      else closedHints.delete(key);
    }
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
        union(alias, canonical, "catalogue");
        if (canonical) promote(canonical);
      }
    },

    observeIndex(sessions) {
      // Two passes: every row identity is registered before any edge is judged, so whether a
      // union is refused cannot depend on row order within the batch.
      const batch = [...sessions];
      for (const session of batch) {
        if (session.sessionId) {
          register(session.sessionId);
          indexPrimary.add(session.sessionId);
        }
      }
      for (const session of batch) {
        union(session.sessionId, session.resumeId, "index");
        if (session.sessionId) promote(session.sessionId);
      }
    },

    observeActiveWindow(activeWindowId, liveWindowIds) {
      if (activeWindowId !== null) {
        lastActiveWindowId = activeWindowId;
        return activeWindowId;
      }
      if (
        lastActiveWindowId !== null
        && liveWindowIds !== undefined
        && !liveWindowIds.has(lastActiveWindowId)
      ) {
        // The remembered window is gone from a readable tree: it closed. Answering with it
        // anyway would filter every sessionless workspace against a window none can be in.
        lastActiveWindowId = null;
      }
      return lastActiveWindowId;
    },

    aliasesFor(sessionId) {
      return componentOf(sessionId);
    },

    canonicalFor(sessionId) {
      return find(sessionId);
    },

    canonicalMap() {
      // Rebuilt only when the graph actually changed; snapshots poll every second and the graph
      // holds every id ever observed, so an uncached rebuild would be the hot path's biggest map.
      if (cachedCanonicalMap !== null && cachedCanonicalMap.generation === generation) {
        return cachedCanonicalMap.map;
      }
      const map = new Map<string, string>();
      for (const key of parent.keys()) map.set(key, find(key));
      cachedCanonicalMap = { generation, map };
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
      const writtenAt = now();
      const until = writtenAt + Math.max(0, resumeTtl);
      for (const key of canonicalKeys(sessionIds)) {
        resumeHints.set(key, { until, writtenAt, target });
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
      for (const [key, hint] of resumeHints) map.set(key, hint.target);
      return map;
    },

    noteClosed(sessionIds, workspaceId) {
      sweep();
      const writtenAt = now();
      const until = writtenAt + Math.max(0, closedTtl);
      for (const key of canonicalKeys(sessionIds)) {
        closedHints.set(key, { until, writtenAt, workspaceId: workspaceId ?? null });
        resumeHints.delete(key);
      }
    },

    isRecentlyClosed(sessionId, boundWorkspaceId) {
      sweep();
      const hint = closedHints.get(find(sessionId));
      if (hint === undefined) return false;
      if (boundWorkspaceId === undefined || hint.workspaceId === null) return true;
      return hint.workspaceId === boundWorkspaceId;
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
        closedHints: [...closedHints.entries()].map(([id, hint]) => ({
          sessionId: id,
          workspaceId: hint.workspaceId,
          expiresInMs: Math.max(0, hint.until - now()),
        })),
        lastActiveWindowId,
      };
    },
  };
}
