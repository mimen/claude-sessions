import { z } from "zod";

/**
 * The enrichment contract: what one structured inference pass over a session transcript is
 * allowed to assert about that session.
 *
 * Enrichment is OBSERVED state — what the transcript shows actually happened. It is deliberately
 * distinct from the catalogue's `lifecycle` (idle | parked | completed | archived), which is
 * STORED INTENT set by a human or a skill. The gap between the two is the signal: a session whose
 * lifecycle says `idle` but whose enrichment recommends `complete` is one you finished and never
 * closed out. `ccs triage` is the surface that works that gap.
 *
 * There is intentionally no `status` field. An earlier draft carried `in-progress | blocked |
 * wrapped`, but the catalogue already has three status-shaped axes (lifecycle, plus the
 * role-scoped `stage` and `activity`), and a fourth would have been one more thing to keep
 * mutually coherent. `recommendation` carries the actionable read on its own.
 *
 * v40 splits the two prose fields. `summary` was one paragraph that had to be both "where this
 * stands" and "how it got here", and in practice it was always written in that order — narration
 * first, state buried in the final clause — so the reader had to parse a chronicle to find a
 * status. `state` and `history` make the separation structural, because an instruction to lead
 * with the state is something a model can drift from and two columns are not. `outstanding` split
 * the same way: 199 of 371 real values chained several actions into one comma-run, so `next` now
 * holds exactly one.
 */

/** What to DO with a session. Each value maps to an existing CCS action; none of them destroy data. */
export const RECOMMENDATIONS = ["continue", "complete", "archive", "handoff"] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/**
 * `delete` is deliberately absent. CCS has no delete — lifecycle is a fixed enum and the store is
 * an append-only forensic record — so a model-suggested deletion had nowhere honest to go. Junk
 * sessions are archived like any other dead end, and the separate `junk` boolean preserves the
 * "was never worth starting" distinction without making a model suggestion the trigger for
 * irreversible loss.
 */
export const RECOMMENDATION_ACTIONS: Readonly<Record<Recommendation, string>> = {
  continue: "none — the session stays active",
  complete: "ccs mark --completed (success, stays visible in history)",
  archive: "ccs mark --archived (dead end, hidden from active views)",
  handoff: "the handoff skill (pass the thread to another session or person)",
};

/**
 * Field budgets.
 *
 * These are a backstop against a runaway generation filling a catalogue column, NOT a style
 * guide — so they sit well above the length actually asked for in the schema descriptions, which
 * is where the model is told to be brief. An earlier revision had them at 600/300 without telling
 * the model anything, and rejected two thirds of real sessions for writing three ordinary
 * sentences: a limit the model is never shown is a limit it cannot respect. First-pass success
 * went from 33% to 93% when the asked-for lengths moved into the descriptions and the caps moved
 * out of the way.
 *
 * The same trap is available in v40 and is worth naming: a cap set AT the requested length is not
 * a backstop, it is a rejection rule for anything that overshoots by a word.
 */
const MAX_STATE = 700;
const MAX_HISTORY = 700;
const MAX_NEXT = 250;
const MAX_REMAINING = 400;
const MAX_REASON = 400;

/**
 * Titles are rendered in a fixed-width list column and truncated hard, so a long one is not
 * merely verbose — it is invisible past the cutoff. The asked-for length is well under the cap.
 */
const MAX_TITLE = 120;
const TARGET_TITLE_CHARS = 60;

/** What the model is ASKED for, as opposed to what the parser will tolerate. */
const TARGET_STATE_CHARS = 250;
const TARGET_HISTORY_CHARS = 250;
const TARGET_NEXT_CHARS = 100;
const TARGET_REMAINING_CHARS = 200;
const TARGET_REASON_CHARS = 200;

/**
 * The raw shape the model must return. Field-level limits are enforced here so a runaway
 * generation can't write a novel into a catalogue column; cross-field coherence is enforced by
 * `validateEnrichment` below, which also needs the location registry.
 *
 * The three cwd fields are OPTIONAL at the zod layer because the question is registry-gated: when
 * no location registry is installed, `enrichmentJsonSchema` omits those properties entirely and
 * the model is never asked. Their coherence — including "they must be absent when the question
 * wasn't asked" — is enforced in `validateEnrichment`, which knows whether a registry existed.
 */
export const EnrichmentPayloadSchema = z.object({
  /**
   * A better name for the session than the ones generated before it happened.
   *
   * The existing titles come from the first message (a fallback label), or from Claude Code's own
   * early `ai-title`, or from the codex titler — all of which see the opening of a session and
   * guess where it is going. Enrichment reads how it actually ended, so it is simply better
   * positioned. This never overwrites a title a human set; see `enrichment_title` in db-schema.ts.
   */
  title: z.string().trim().min(1).max(MAX_TITLE),
  /** Where the session stands now. The only field a reader is guaranteed to see. */
  state: z.string().trim().min(1).max(MAX_STATE),
  /** How it got there. Rendered on demand, so it may be empty on a short session. */
  history: z.string().trim().max(MAX_HISTORY),
  /** The one thing to do first on resuming. Empty when nothing is open. */
  next: z.string().trim().max(MAX_NEXT),
  /** Everything still open after `next`. */
  remaining: z.string().trim().max(MAX_REMAINING),
  recommendation: z.enum(RECOMMENDATIONS),
  /**
   * Conditional, not optional-in-spirit: required for archive/handoff/junk and required to be
   * EMPTY otherwise. `.min(1)` is gone because "empty" is now a legal, and usually correct, value.
   */
  reason: z.string().trim().max(MAX_REASON),
  junk: z.boolean(),
  cwdCorrect: z.boolean().optional(),
  suggestedLocation: z.string().trim().max(120).optional(),
  suggestedCwd: z.string().trim().max(400).optional(),
  /** Present only when deterministic category evidence was unresolved or conflicting. */
  categorySlug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
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
 * `knownLocationKeys` doubles as the registry-present signal: an empty set means the cwd question
 * was never put to the model, so any cwd answer is a hallucination rather than a judgement and is
 * rejected outright. When the registry does exist, the location check mirrors the guard in
 * `src/start/gateway.ts` — a model may only name an id that was supplied to it.
 *
 * Returns null when the payload is coherent, or a human-actionable string when it is not.
 */
export function validateEnrichment(
  payload: EnrichmentPayload,
  knownLocationKeys: ReadonlySet<string>,
): string | null {
  const reasonProblem = validateReason(payload);
  if (reasonProblem) return reasonProblem;

  // Junk is "never worth starting". A probe that returned PONG did technically succeed, but
  // `complete` files it into the success history, which is the wrong shelf — 17 real rows landed
  // there under v39. The two axes stay separate (junk still distinguishes an accidental launch
  // from a real attempt that failed); only the recommendation is pinned.
  if (payload.junk && payload.recommendation !== "archive") {
    return `junk sessions must be recommended for archive, not "${payload.recommendation}"`;
  }

  // A session worth resuming must say what resuming starts with.
  if (payload.recommendation === "continue" && !payload.next) {
    return "continue requires a next action";
  }
  // There is deliberately NO "remaining requires next" rule. An earlier revision had one, on the
  // reasoning that the first action belongs in `next` — and the first real sweep rejected 18
  // sessions for it, the single largest failure cause in the run. The rule was simply wrong: a
  // finished session can carry optional leftovers with no required next step ("optionally delete
  // the private key now that it is in the Keychain"), and forcing that into `next` would invent an
  // obligation the session does not have. Same shape as the v39 length-cap defect: a constraint
  // the model violates because the constraint, not the answer, is mistaken.

  return validateCwd(payload, knownLocationKeys);
}

/**
 * `reason` earns its line only when the verdict is one a reader would otherwise distrust.
 *
 * On `continue` and `complete` it restated the pill in hedged prose on all 401 real rows that
 * carried it — "the work is incomplete" under a `continue` badge is not information. The rule is
 * deterministic rather than an instruction to "mention it when interesting", because that is
 * exactly the kind of judgement a model applies loosely and inconsistently.
 */
function validateReason(payload: EnrichmentPayload): string | null {
  const needsReason =
    payload.recommendation === "archive" || payload.recommendation === "handoff" || payload.junk;
  if (needsReason && !payload.reason) {
    return `recommendation "${payload.recommendation}"${payload.junk ? " (junk)" : ""} requires a reason`;
  }
  if (!needsReason && payload.reason) {
    return "reason is only for archive, handoff, or junk — leave it empty otherwise";
  }
  return null;
}

/**
 * The cwd judgement, gated on the registry actually existing.
 *
 * Under v39 this ran unconditionally, and because `~/.ccs/locations.toml` was never installed on
 * this machine every one of 155 "wrong directory" verdicts took the free-text escape hatch —
 * including `/Users/mimen/claude-sessions`, which does not exist, and a bare `/Users/mimen`. A
 * model asked a question it cannot answer well will answer it anyway.
 */
function validateCwd(
  payload: EnrichmentPayload,
  knownLocationKeys: ReadonlySet<string>,
): string | null {
  const answered =
    payload.cwdCorrect !== undefined || !!payload.suggestedLocation || !!payload.suggestedCwd;

  if (knownLocationKeys.size === 0) {
    // The properties were stripped from the schema for this call, so anything here was invented.
    return answered ? "cwd fields were returned but no location registry was supplied" : null;
  }
  if (payload.cwdCorrect === undefined) return "cwdCorrect is required when a registry is supplied";

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
 *
 * `withLocations` is false when no registry is installed: the three cwd properties come out of the
 * schema entirely rather than being asked and ignored. A question a model is not asked is a
 * question it cannot invent an answer to.
 */
type JsonSchemaValue = string | number | boolean | readonly string[] | { readonly [key: string]: JsonSchemaValue };

export function enrichmentJsonSchema(
  withLocations: boolean,
  categorySlugs: readonly string[] = [],
): { readonly [key: string]: JsonSchemaValue } {
  const required = [
    "title", "state", "history", "next", "remaining", "recommendation", "reason", "junk",
  ];
  const properties: Record<string, JsonSchemaValue> = {
    title: {
      type: "string",
      description:
        "A short, specific name for what this session actually turned out to be — the name it " +
        "would have been given if anyone had known in advance. Name the concrete thing worked " +
        "on, not the activity: 'Transactional catalogue migrations', not 'Debugging session'. " +
        `No trailing punctuation, no quotes, at most ${TARGET_TITLE_CHARS} characters.`,
    },
    state: {
      type: "string",
      description:
        "Where this session STANDS RIGHT NOW. This is the one field the reader is guaranteed to " +
        "see, and they are picking the session up cold weeks later. " +
        "Open with the current state: what exists, what works, what is broken, and where it " +
        "physically lives (branch, worktree, path) when that is what someone would need to " +
        "resume. Present tense. Address the reader as 'you' — these are their own sessions, so " +
        "never write 'the user'. Plain verbs and no hedging: not 'substantially complete', not " +
        "'largely working'. " +
        "Do NOT narrate the session in the order things happened — that is `history`. " +
        "Do NOT say what is unfinished — that is `next`. " +
        "Do NOT justify the recommendation — that is `reason`. " +
        "Include a number only when it changes what to do next; test counts, percentages, and " +
        "line counts are proof of effort, not information. " +
        `At most two sentences, about ${TARGET_STATE_CHARS} characters.`,
    },
    history: {
      type: "string",
      description:
        "How it got there: what was attempted, what was decided, what was learned. Past tense. " +
        "This is the part a reader skips unless they want it, so nothing required in order to " +
        "act belongs here. Metrics that were cut from `state` can live here. " +
        `At most two sentences, about ${TARGET_HISTORY_CHARS} characters. ` +
        "Empty string when the session is short enough that `state` already says everything.",
    },
    next: {
      type: "string",
      description:
        "The single thing you would do FIRST on sitting back down at this session. " +
        "Imperative, no lead-in, no 'the user should'. Exactly one action: when several things " +
        "remain, name the one that unblocks the rest and put the others in `remaining`. " +
        `Empty string only when nothing is open. About ${TARGET_NEXT_CHARS} characters.`,
    },
    remaining: {
      type: "string",
      description:
        "Everything still open after `next`, so a reader can judge scope before committing. " +
        "A phrase or two, not a plan. Empty string when `next` is the whole of it. " +
        `About ${TARGET_REMAINING_CHARS} characters.`,
    },
    recommendation: {
      type: "string",
      enum: [...RECOMMENDATIONS],
      description:
        "continue = live work worth resuming, and ONLY when the work has not already landed. " +
        "complete = it succeeded and is done. archive = abandoned, superseded, or a dead end. " +
        "handoff = needs to pass to another session or person. " +
        "Weigh the <world> block: a branch that is gone or already merged, or many later " +
        "sessions in the same directory, means the work most likely landed — prefer complete or " +
        "archive over continue. A transcript that stops mid-sentence is how every abandoned " +
        "session looks, so 'it ended abruptly' is not on its own a reason to continue.",
    },
    reason: {
      type: "string",
      description:
        "ONLY for archive, handoff, or junk: one line on why, stated so that a reader inclined " +
        "to disagree would find it persuasive. " +
        "MUST be an empty string for continue and complete — there the verdict speaks for " +
        `itself and a restatement is noise. At most ${TARGET_REASON_CHARS} characters.`,
    },
    junk: {
      type: "boolean",
      description:
        "True only for sessions that were never worth starting — a one-line probe, an accidental " +
        "launch, a trivial throwaway. A real attempt that failed is NOT junk. " +
        "When true, recommendation must be archive.",
    },
  };

  if (categorySlugs.length > 0) {
    required.push("categorySlug");
    properties.categorySlug = {
      type: "string",
      enum: categorySlugs,
      description: "The single best life-domain category for this root session. Choose exactly one supplied slug.",
    };
  }

  if (withLocations) {
    required.push("cwdCorrect", "suggestedLocation", "suggestedCwd");
    properties.cwdCorrect = {
      type: "boolean",
      description: "Whether the session's working directory is a sensible home for the work it actually did.",
    };
    properties.suggestedLocation = {
      type: "string",
      description:
        "When cwdCorrect is false, the key of the registered location this work belongs in. Must be one of the " +
        "supplied location keys — never invent one. Empty string otherwise.",
    };
    properties.suggestedCwd = {
      type: "string",
      description:
        "Only when cwdCorrect is false AND no supplied location fits: an absolute path that should probably be " +
        "registered as a new location. Empty string otherwise. Never set this together with suggestedLocation.",
    };
  }

  return { type: "object", additionalProperties: false, required, properties };
}
