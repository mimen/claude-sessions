import { mintWorkUnit, findWorkUnitByAnchor, type WorkUnit } from "../state/work-units.ts";

/**
 * The canonical work-unit resolver (ADR-0057): find-or-mint a work-unit id from
 * the anchor attributes (PR/GUS) or sessionId. This is the single home the 6
 * derived-string copies (spawnWorkUnit/rowWorkUnit + 4 variants) will eventually
 * call. For now it's additive — the old copies stay, with TODO markers.
 *
 * Find-or-create logic:
 * 1. If PR anchor present: look up work-unit by (prRepo, prNumber); if found return id,
 *    else mint with PR anchor.
 * 2. Else if GUS anchor present: look up by gusWork; if found return id, else mint with GUS.
 * 3. Else (anchorless): mint a new work-unit with no anchor (gets an incrementing wu_anon_N id).
 *    The sessionId is passed for potential future per-session work-unit allocation, but for now
 *    anchorless work-units are separate (no auto-reconnection).
 *
 * Returns the stable work-unit id. Two separate spawns for the same real work (same anchor)
 * reconnect to the same work-unit id — that's the identity dedup + lineage foundation.
 */
export function resolveWorkUnit(
  cluster: string,
  opts: {
    prRepo?: string | null;
    prNumber?: number | null;
    gusWork?: string | null;
    sessionId?: string; // for potential future per-session allocation; unused for now
    /** ADR-0069 anchor type from the role. When given, it DISPATCHES which attribute reconnects the
     * work-unit; when omitted, the resolver infers PR-then-GUS (the pre-0069 behavior, for callers
     * like the backfill that only have the row's attributes). */
    anchorType?: "pr" | "gus" | "freeform" | "none";
  },
  now: string,
  source = "cli",
): string {
  // ADR-0069: dispatch on the declared anchor type. `pr`/`gus` reconnect by that attribute;
  // `freeform` mints an id with no auto-reconnect. When no anchorType is given, infer (PR then GUS
  // then anchorless) — the pre-0069 behavior, so the backfill + attribute-only callers still work.
  const at = opts.anchorType;
  const tryPr = (at === "pr" || at === undefined) && opts.prRepo && opts.prNumber;
  const tryGus = (at === "gus" || at === undefined) && opts.gusWork;

  if (tryPr) {
    const found = findWorkUnitByAnchor(cluster, { prRepo: opts.prRepo!, prNumber: opts.prNumber! });
    if (found) return found;
    return mintWorkUnit(cluster, { prRepo: opts.prRepo, prNumber: opts.prNumber, gusWork: opts.gusWork }, now, source);
  }
  if (tryGus) {
    const found = findWorkUnitByAnchor(cluster, { gusWork: opts.gusWork! });
    if (found) return found;
    return mintWorkUnit(cluster, { gusWork: opts.gusWork }, now, source);
  }

  // freeform (or no resolvable anchor) — mint an anchorless work-unit (wu_anon_N); no reconnection.
  return mintWorkUnit(cluster, {}, now, source);
}
