import { z } from "zod";

/**
 * The enrichment contract: what one structured inference pass over a session transcript is
 * allowed to assert about that session.
 *
 * Enrichment is OBSERVED state — what the transcript shows actually happened. It is deliberately
 * distinct from the catalogue's `lifecycle` (idle | parked | completed | archived), which is
 * STORED INTENT set by a human or a skill. The gap between the two is the signal: a session whose
 * lifecycle says `idle` but whose enrichment recommends `complete` is one you finished and never
 * closed out.
 *
 * There is intentionally no `status` field. An earlier draft carried `in-progress | blocked |
 * wrapped`, but the catalogue already has three status-shaped axes (lifecycle, plus the
 * role-scoped `stage` and `activity`), and a fourth would have been one more thing to keep
 * mutually coherent. `recommendation` carries the actionable read on its own.
 */

/** What to DO with a session. Each value maps to an existing CCS action; none of them destroy data. */
export const RECOMMENDATIONS = ["continue", "complete", "archive", "handoff"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/**
 * `delete` is deliberately absent. CCS has no delete — lifecycle is a fixed enum and the store is
 * an append-only forensic record — so a model-suggested deletion had nowhere honest to go. Junk
 * sessions are archived like any other dead end, and the separate `junk` boolean preserves the
 * "was never worth starting" distinction for a future sweep without making a model suggestion the
 * trigger for irreversible loss.
 */
export const RECOMMENDATION_ACTIONS: Readonly<Record<Recommendation, string>> = {
  continue: "none — the session stays active",
  complete: "ccs mark --completed (success, stays visible in history)",
  archive: "ccs mark --archived (dead end, hidden from active views)",
  handoff: "the handoff skill (pass the thread to another session or person)",
};

const MAX_SUMMARY = 600;
const MAX_LINE = 300;

/**
 * The raw shape the model must return. Field-level limits are enforced here so a runaway
 * generation can't write a novel into a catalogue column; cross-field coherence is enforced by
 * `validateEnrichment` below, which also needs the location registry.
 */
export const EnrichmentPayloadSchema = z.object({
  summary: z.string().trim().min(1).max(MAX_SUMMARY),
  outstanding: z.string().trim().max(MAX_LINE),
  recommendation: z.enum(RECOMMENDATIONS),
  reason: z.string().trim().min(1).max(MAX_LINE),
  junk: z.boolean(),
  cwdCorrect: z.boolean(),
  suggestedLocation: z.string().trim().max(120),
  suggestedCwd: z.string().trim().max(400),
}).strict();

export type EnrichmentPayload = z.infer<typeof EnrichmentPayloadSchema>;

/** An enrichment as stored: the model's assertions plus the provenance that makes staleness computable. */
export interface Enrichment extends EnrichmentPayload {
  /** Session message count at the moment of generation. Staleness is `current − this`. */
  readonly atMessages: number;
  /** ISO timestamp of generation, for the wall-time backstop. */
  readonly at: string;
}

/**
 * Cross-field validation, including the checks that need the caller's world.
 *
 * The location check mirrors the guard in `src/start/gateway.ts`: a model may only name an id that
 * was supplied to it. Free-text `suggestedCwd` is the escape hatch for the genuine "no registered
 * location fits this work" case — which is itself useful signal, since it means a location should
 * probably be registered.
 *
 * Returns null when the payload is coherent, or a human-actionable string when it is not.
 */
export function validateEnrichment(
  payload: EnrichmentPayload,
  knownLocationKeys: ReadonlySet<string>,
): string | null {
  if (payload.cwdCorrect) {
    if (payload.suggestedLocation || payload.suggestedCwd) {
      return "cwdCorrect=true must not carry a suggestedLocation or suggestedCwd";
    }
    return null;
  }
  if (!payload.suggestedLocation && !payload.suggestedCwd) {
    return "cwdCorrect=false requires a suggestedLocation (preferred) or a suggestedCwd";
  }
  if (payload.suggestedLocation && !knownLocationKeys.has(payload.suggestedLocation)) {
    return `suggestedLocation "${payload.suggestedLocation}" is not a registered location key`;
  }
  // A registry key always beats a free-text path, so reject the ambiguous both-set case rather
  // than silently preferring one — it means the model hedged and the answer isn't trustworthy.
  if (payload.suggestedLocation && payload.suggestedCwd) {
    return "set suggestedLocation OR suggestedCwd, not both";
  }
  return null;
}

/**
 * JSON Schema for the forced `answer` tool call. Written by hand rather than generated from the
 * zod schema so the descriptions the model actually reads live next to the constraints, and so the
 * wire contract can't drift silently when the zod schema is refactored.
 */
type JsonSchemaValue = string | number | boolean | readonly string[] | { readonly [key: string]: JsonSchemaValue };

export function enrichmentJsonSchema(): { readonly [key: string]: JsonSchemaValue } {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "summary", "outstanding", "recommendation", "reason",
      "junk", "cwdCorrect", "suggestedLocation", "suggestedCwd",
    ],
    properties: {
      summary: {
        type: "string",
        description: "Two or three sentences: what this session was for and where it actually ended up. Concrete, no filler.",
      },
      outstanding: {
        type: "string",
        description: "One line naming what is still unfinished or unanswered. Empty string when nothing is open.",
      },
      recommendation: {
        type: "string",
        enum: [...RECOMMENDATIONS],
        description:
          "continue = live work worth resuming. complete = it succeeded and is done. " +
          "archive = abandoned or a dead end. handoff = needs to pass to another session or person.",
      },
      reason: { type: "string", description: "One line justifying the recommendation." },
      junk: {
        type: "boolean",
        description:
          "True only for sessions that were never worth starting — a one-line probe, an accidental launch, a trivial " +
          "throwaway. A real attempt that failed is NOT junk.",
      },
      cwdCorrect: {
        type: "boolean",
        description: "Whether the session's working directory is a sensible home for the work it actually did.",
      },
      suggestedLocation: {
        type: "string",
        description:
          "When cwdCorrect is false, the key of the registered location this work belongs in. Must be one of the " +
          "supplied location keys — never invent one. Empty string otherwise.",
      },
      suggestedCwd: {
        type: "string",
        description:
          "Only when cwdCorrect is false AND no supplied location fits: an absolute path that should probably be " +
          "registered as a new location. Empty string otherwise. Never set this together with suggestedLocation.",
      },
    },
  };
}
