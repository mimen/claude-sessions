import type { Database } from "bun:sqlite";
import { getAll, lifecycleOf, type CatalogueRow, type Lifecycle } from "../catalogue/db.ts";
import { recommendationDisagreement } from "../catalogue/enrichment.ts";
import { listByRecency, type SessionRow } from "../index/index.ts";
import type { Recommendation } from "../catalogue/enrichment-schema.ts";

/**
 * The gap between what a session IS and what it is FILED AS.
 *
 * `enrichment-schema.ts` states the intent: enrichment is observed state, lifecycle is stored
 * intent, and the difference between them is the signal. Until now nothing read that difference.
 * On the live store it was 162 sessions wide — recommended `complete`, still sitting at `idle` —
 * which is a fortnight of finished work that never got closed out, invisible because the only way
 * to see it was to open sessions one at a time.
 *
 * This module is the pure half: it decides what disagrees and how, and holds no I/O and no
 * rendering, so the rule is testable without a terminal.
 */

export interface TriageItem {
  readonly sessionId: string;
  readonly title: string;
  readonly state: string;
  readonly reason: string;
  readonly recommendation: Recommendation;
  readonly lifecycle: Lifecycle;
  /** What applying the recommendation would set. */
  readonly target: Lifecycle;
  readonly junk: boolean;
  readonly cwd: string | null;
  readonly lastTs: string | null;
  readonly messages: number;
}

export interface TriageQueue {
  /**
   * Probes and throwaways, grouped so they can be cleared in one keystroke instead of 28.
   *
   * Safe to treat in bulk on the evidence: the largest junk session in the real store is 16
   * messages and none of them contain work. Kept as its own lane rather than auto-archived,
   * because a model verdict driving a lifecycle write unattended is the line this design does not
   * cross — a keypress is cheap, and reversing 28 wrong archives is not.
   */
  readonly junk: readonly TriageItem[];
  /** Everything else that disagrees, most recently active first. */
  readonly items: readonly TriageItem[];
}

/**
 * Sessions whose enrichment verdict contradicts their stored lifecycle.
 *
 * Ordered by recency because the sessions you last touched are the ones you can still judge
 * without opening them — a queue sorted oldest-first would front-load exactly the items where a
 * keypress is least informed.
 */
export function triageQueue(index: Database, catalogue: Database): TriageQueue {
  const rows = getAll(catalogue);
  const junk: TriageItem[] = [];
  const items: TriageItem[] = [];

  for (const session of listByRecency(index, false)) {
    if (session.isSubagent) continue;
    const row = rows.get(session.sessionId);
    if (row?.sessionClass === "auxiliary") continue;
    const item = disagreement(session, row ?? null);
    if (!item) continue;
    (item.junk ? junk : items).push(item);
  }
  return { junk, items };
}

/** One session's disagreement, or null when enrichment and lifecycle already agree. */
export function disagreement(session: SessionRow, row: CatalogueRow | null): TriageItem | null {
  const enrichment = row?.enrichment;
  if (!enrichment) return null;
  const lifecycle = lifecycleOf(row);
  const target = recommendationDisagreement(
    enrichment.recommendation,
    enrichment.declined,
    lifecycle,
  );
  if (!target || !enrichment.recommendation) return null;

  return {
    sessionId: session.sessionId,
    title: enrichment.title || session.title,
    state: enrichment.state ?? "",
    reason: enrichment.reason ?? "",
    recommendation: enrichment.recommendation,
    lifecycle,
    target,
    junk: enrichment.junk,
    cwd: session.cwd,
    lastTs: session.lastTs,
    messages: session.msgCount,
  };
}

export interface NextItem {
  readonly sessionId: string;
  readonly title: string;
  readonly next: string;
  readonly remaining: string;
  readonly cwd: string | null;
  readonly lastTs: string | null;
}

/**
 * What you are mid-flight on: every session still recommended `continue`, and the one action each
 * would start with.
 *
 * Deliberately derived and never stored. Nothing can be added to this list, so it cannot drift
 * from the sessions it describes, and closing a session out makes its row disappear on the next
 * run without anyone having to remember to remove it.
 */
export function nextActions(index: Database, catalogue: Database): NextItem[] {
  const rows = getAll(catalogue);
  const out: NextItem[] = [];
  for (const session of listByRecency(index, false)) {
    if (session.isSubagent) continue;
    const row = rows.get(session.sessionId);
    if (row?.sessionClass === "auxiliary") continue;
    const enrichment = row?.enrichment;
    if (!enrichment || enrichment.recommendation !== "continue" || !enrichment.next) continue;
    // A session the human already closed out is not mid-flight, whatever the last sweep thought.
    const lifecycle = lifecycleOf(row ?? null);
    if (lifecycle !== "idle") continue;
    out.push({
      sessionId: session.sessionId,
      title: enrichment.title || session.title,
      next: enrichment.next,
      remaining: enrichment.remaining ?? "",
      cwd: session.cwd,
      lastTs: session.lastTs,
    });
  }
  return out;
}
