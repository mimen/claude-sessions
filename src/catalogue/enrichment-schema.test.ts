import { expect, test, describe } from "bun:test";
import {
  EnrichmentPayloadSchema,
  validateEnrichment,
  enrichmentJsonSchema,
  RECOMMENDATIONS,
  type EnrichmentPayload,
} from "./enrichment-schema.ts";

const KNOWN = new Set(["repos-ccs", "vault", "home"]);
/** No registry installed — the state this machine has actually been in since v38 shipped. */
const NO_REGISTRY = new Set<string>();

function payload(overrides: Partial<EnrichmentPayload> = {}): EnrichmentPayload {
  return {
    title: "Session enrichment",
    state: "The sweep runs and writes to the catalogue. Nothing is wired to the TUI yet.",
    history: "Built the enrichment sweep and wired it to the catalogue.",
    next: "Wire the dossier to read the new columns",
    remaining: "",
    recommendation: "continue",
    reason: "",
    junk: false,
    cwdCorrect: true,
    suggestedLocation: "",
    suggestedCwd: "",
    ...overrides,
  };
}

describe("EnrichmentPayloadSchema", () => {
  test("rejects a recommendation outside the enum", () => {
    // `delete` was cut deliberately — CCS has no delete, so the model must never propose one.
    const parsed = EnrichmentPayloadSchema.safeParse({ ...payload(), recommendation: "delete" });
    expect(parsed.success).toBe(false);
  });

  test("accepts every value the enum advertises", () => {
    for (const recommendation of RECOMMENDATIONS) {
      const needsReason = recommendation === "archive" || recommendation === "handoff";
      expect(EnrichmentPayloadSchema.safeParse(
        payload({ recommendation, reason: needsReason ? "Superseded." : "" }),
      ).success).toBe(true);
    }
  });

  test("rejects unknown fields rather than silently dropping them", () => {
    const parsed = EnrichmentPayloadSchema.safeParse({ ...payload(), status: "blocked" });
    expect(parsed.success).toBe(false);
  });

  test("caps a runaway state instead of writing it to a column", () => {
    const parsed = EnrichmentPayloadSchema.safeParse(payload({ state: "x".repeat(5_000) }));
    expect(parsed.success).toBe(false);
  });

  test("requires a non-empty state", () => {
    expect(EnrichmentPayloadSchema.safeParse(payload({ state: "   " })).success).toBe(false);
  });

  test("permits an empty reason, history, next, and remaining", () => {
    // v40 inverts v39 here: `reason` is empty on every continue/complete, `history` is empty on a
    // short session, and `next` is empty when nothing is open. A `.min(1)` on any of them would
    // reject the common case.
    const parsed = EnrichmentPayloadSchema.safeParse(
      payload({ recommendation: "complete", reason: "", history: "", next: "", remaining: "" }),
    );
    expect(parsed.success).toBe(true);
  });

  test("the caps sit well above the lengths the descriptions ask for", () => {
    // The v39 regression this pins: caps set AT the requested length rejected two thirds of real
    // sessions for writing three ordinary sentences. A backstop that trips on a normal answer is
    // not a backstop.
    const schema = enrichmentJsonSchema(true);
    const properties = schema.properties as Record<string, { description?: string }>;
    const asked = /about (\d+) characters/.exec(properties.state?.description ?? "");
    expect(asked).not.toBeNull();
    const askedFor = Number(asked![1]);
    const atAskedLength = EnrichmentPayloadSchema.safeParse(payload({ state: "x".repeat(askedFor) }));
    expect(atAskedLength.success).toBe(true);
    // And comfortably past it, since "about 250" is not a limit the model can hit exactly.
    expect(EnrichmentPayloadSchema.safeParse(
      payload({ state: "x".repeat(Math.round(askedFor * 1.8)) }),
    ).success).toBe(true);
  });
});

describe("validateEnrichment · reason is conditional", () => {
  test("continue and complete must not carry a reason", () => {
    for (const recommendation of ["continue", "complete"] as const) {
      const problem = validateEnrichment(
        payload({ recommendation, reason: "The work is incomplete." }), KNOWN,
      );
      expect(problem).toMatch(/only for archive, handoff, or junk/);
    }
  });

  test("archive and handoff must carry one", () => {
    for (const recommendation of ["archive", "handoff"] as const) {
      const problem = validateEnrichment(payload({ recommendation, reason: "" }), KNOWN);
      expect(problem).toMatch(/requires a reason/);
    }
  });

  test("junk requires a reason even though its recommendation is archive", () => {
    const problem = validateEnrichment(
      payload({ junk: true, recommendation: "archive", reason: "" }), KNOWN,
    );
    expect(problem).toMatch(/requires a reason/);
  });

  test("a justified archive passes", () => {
    expect(validateEnrichment(
      payload({ recommendation: "archive", reason: "Superseded by the v40 branch.", next: "" }),
      KNOWN,
    )).toBeNull();
  });
});

describe("validateEnrichment · junk implies archive", () => {
  test("junk cannot be filed as complete", () => {
    // 17 real rows did exactly this under v39. A PONG probe technically succeeded, but `complete`
    // puts "Unavailable fake todo tool probe" in the success history.
    const problem = validateEnrichment(
      payload({ junk: true, recommendation: "complete", reason: "It answered." }), KNOWN,
    );
    expect(problem).toMatch(/must be recommended for archive/);
  });

  test("junk as archive passes", () => {
    expect(validateEnrichment(
      payload({ junk: true, recommendation: "archive", reason: "Four-turn connectivity probe.", next: "" }),
      KNOWN,
    )).toBeNull();
  });
});

describe("validateEnrichment · next and remaining", () => {
  test("continue requires a next action", () => {
    const problem = validateEnrichment(payload({ recommendation: "continue", next: "" }), KNOWN);
    expect(problem).toMatch(/continue requires a next action/);
  });

  test("a finished session may carry optional leftovers with no next action", () => {
    // The first real sweep rejected 18 sessions on a "remaining requires next" rule, which was
    // the largest single failure cause in the run and simply wrong: "optionally delete the private
    // key now that it is in the Keychain" is a genuine leftover with no obligation attached.
    // Forcing it into `next` would invent work the session does not have.
    expect(validateEnrichment(
      payload({ recommendation: "complete", next: "", remaining: "optionally delete the stale key" }),
      KNOWN,
    )).toBeNull();
  });
});

describe("validateEnrichment · cwd is registry-gated", () => {
  test("a correct cwd carries no suggestion", () => {
    expect(validateEnrichment(payload(), KNOWN)).toBeNull();
  });

  test("rejects a suggestion attached to a cwd it just called correct", () => {
    const problem = validateEnrichment(
      payload({ cwdCorrect: true, suggestedLocation: "vault" }), KNOWN,
    );
    expect(problem).toMatch(/must not carry/);
  });

  test("rejects an incorrect cwd with no proposed home", () => {
    const problem = validateEnrichment(payload({ cwdCorrect: false }), KNOWN);
    expect(problem).toMatch(/requires a suggestedLocation/);
  });

  test("refuses a location key that was never offered", () => {
    // The guard that makes constrained output worth having: without it the model can return a
    // confident, well-formed, entirely invented destination.
    const problem = validateEnrichment(
      payload({ cwdCorrect: false, suggestedLocation: "some-repo-that-does-not-exist" }), KNOWN,
    );
    expect(problem).toMatch(/is not a registered location key/);
  });

  test("accepts a registered key", () => {
    expect(validateEnrichment(
      payload({ cwdCorrect: false, suggestedLocation: "repos-ccs" }), KNOWN,
    )).toBeNull();
  });

  test("accepts free-text only as the no-registered-home escape hatch", () => {
    expect(validateEnrichment(
      payload({ cwdCorrect: false, suggestedCwd: "/Users/mimen/Programming/Repos/brand-new" }), KNOWN,
    )).toBeNull();
  });

  test("refuses a hedged answer that sets both", () => {
    const problem = validateEnrichment(
      payload({ cwdCorrect: false, suggestedLocation: "vault", suggestedCwd: "/tmp/elsewhere" }),
      KNOWN,
    );
    expect(problem).toMatch(/not both/);
  });

  test("with no registry, a cwd answer is rejected as invented", () => {
    // v39's behaviour was the opposite — free text was allowed through — and on a machine with no
    // registry that produced 155 unverifiable verdicts, including a path that does not exist.
    const problem = validateEnrichment(
      payload({ cwdCorrect: false, suggestedCwd: "/Users/mimen/claude-sessions" }), NO_REGISTRY,
    );
    expect(problem).toMatch(/no location registry was supplied/);
  });

  test("with no registry, omitting the cwd fields entirely is correct", () => {
    const { cwdCorrect, suggestedLocation, suggestedCwd, ...rest } = payload();
    expect(validateEnrichment(rest as EnrichmentPayload, NO_REGISTRY)).toBeNull();
  });

  test("with a registry, cwdCorrect is required", () => {
    const { cwdCorrect, ...rest } = payload();
    expect(validateEnrichment(rest as EnrichmentPayload, KNOWN)).toMatch(/cwdCorrect is required/);
  });
});

describe("enrichmentJsonSchema", () => {
  test("with a location registry, the wire contract includes every question actually asked", () => {
    // Category is a second, independently gated question. Without fallback choices it must remain
    // absent even though the parser can validate it when another call includes it.
    const schema = enrichmentJsonSchema(true);
    const wireFields = Object.keys(schema.properties as Record<string, unknown>).sort();
    const parserFields = Object.keys(EnrichmentPayloadSchema.shape).filter((field) => field !== "categorySlug").sort();
    expect(wireFields).toEqual(parserFields);
    expect((schema.required as readonly string[]).slice().sort()).toEqual(parserFields);
  });

  test("category fallback is a required closed enum only when requested", () => {
    const schema = enrichmentJsonSchema(false, ["ai-systems", "events"]);
    const properties = schema.properties as Record<string, { enum?: readonly string[] }>;
    expect(properties.categorySlug?.enum).toEqual(["ai-systems", "events"]);
    expect(schema.required as readonly string[]).toContain("categorySlug");
    expect(Object.keys(enrichmentJsonSchema(false).properties as Record<string, unknown>)).not.toContain("categorySlug");
  });

  test("without a registry, the cwd properties are absent, not merely optional", () => {
    // The whole mechanism: a question the model is never asked is one it cannot invent an answer
    // to. Leaving the properties in place and ignoring the answer would not have worked.
    const schema = enrichmentJsonSchema(false);
    const wireFields = Object.keys(schema.properties as Record<string, unknown>);
    for (const field of ["cwdCorrect", "suggestedLocation", "suggestedCwd"]) {
      expect(wireFields).not.toContain(field);
      expect(schema.required as readonly string[]).not.toContain(field);
    }
    // Everything else still travels.
    expect(wireFields.sort()).toEqual(
      ["history", "junk", "next", "reason", "recommendation", "remaining", "state", "title"],
    );
  });

  test("the wire enum matches the parser enum", () => {
    const schema = enrichmentJsonSchema(true);
    const properties = schema.properties as Record<string, { enum?: readonly string[] }>;
    expect(properties.recommendation?.enum).toEqual([...RECOMMENDATIONS]);
  });

  test("the descriptions carry the rules the validator enforces", () => {
    // A rule the model is never shown is a rule it cannot follow, and every one of these is
    // enforced by validateEnrichment — so a mismatch means rejections the model cannot learn from.
    const properties = enrichmentJsonSchema(true).properties as Record<string, { description?: string }>;
    expect(properties.reason?.description).toMatch(/empty string for continue and complete/i);
    expect(properties.junk?.description).toMatch(/recommendation must be archive/i);
    expect(properties.state?.description).toMatch(/never write 'the user'/i);
    expect(properties.next?.description).toMatch(/exactly one action/i);
    expect(properties.recommendation?.description).toMatch(/<world>/);
  });
});
