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
  },
  now: string,
  source = "cli",
): string {
  // PR anchor takes precedence (mirrors the old spawnWorkUnit tier)
  if (opts.prRepo && opts.prNumber) {
    const found = findWorkUnitByAnchor(cluster, { prRepo: opts.prRepo, prNumber: opts.prNumber });
    if (found) return found;
    return mintWorkUnit(
      cluster,
      { prRepo: opts.prRepo, prNumber: opts.prNumber },
      now,
      source,
    );
  }

  // GUS anchor second tier
  if (opts.gusWork) {
    const found = findWorkUnitByAnchor(cluster, { gusWork: opts.gusWork });
    if (found) return found;
    return mintWorkUnit(cluster, { gusWork: opts.gusWork }, now, source);
  }

  // No anchor — mint anchorless work-unit (incrementing wu_anon_N id)
  // TODO(ADR-0057): consider per-session allocation here if needed (pass sessionId to mint)
  return mintWorkUnit(cluster, {}, now, source);
}
