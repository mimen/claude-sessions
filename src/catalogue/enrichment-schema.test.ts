import { expect, test, describe } from "bun:test";
import {
  EnrichmentPayloadSchema,
  validateEnrichment,
  enrichmentJsonSchema,
  RECOMMENDATIONS,
  type EnrichmentPayload,
} from "./enrichment-schema.ts";

const KNOWN = new Set(["repos-ccs", "vault", "home"]);

function payload(overrides: Partial<EnrichmentPayload> = {}): EnrichmentPayload {
  return {
    title: "Session enrichment",
    summary: "Built the enrichment sweep and wired it to the catalogue.",
    outstanding: "",
    recommendation: "continue",
    reason: "Work is mid-flight.",
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
      expect(EnrichmentPayloadSchema.safeParse(payload({ recommendation })).success).toBe(true);
    }
  });

  test("rejects unknown fields rather than silently dropping them", () => {
    const parsed = EnrichmentPayloadSchema.safeParse({ ...payload(), status: "blocked" });
    expect(parsed.success).toBe(false);
  });

  test("caps a runaway summary instead of writing it to a column", () => {
    const parsed = EnrichmentPayloadSchema.safeParse(payload({ summary: "x".repeat(5_000) }));
    expect(parsed.success).toBe(false);
  });

  test("requires a non-empty summary and reason", () => {
    expect(EnrichmentPayloadSchema.safeParse(payload({ summary: "   " })).success).toBe(false);
    expect(EnrichmentPayloadSchema.safeParse(payload({ reason: "" })).success).toBe(false);
  });
});

describe("validateEnrichment", () => {
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

  test("an empty registry still permits the free-text path", () => {
    expect(validateEnrichment(
      payload({ cwdCorrect: false, suggestedCwd: "/tmp/x" }), new Set(),
    )).toBeNull();
  });
});

describe("enrichmentJsonSchema", () => {
  test("the wire contract and the parser agree on the field set", () => {
    // These are written independently (hand-authored JSON Schema, zod parser), so nothing but a
    // test stops them drifting — and a drifted required-field list fails at runtime, per session.
    const schema = enrichmentJsonSchema();
    const wireFields = Object.keys(schema.properties as Record<string, unknown>).sort();
    const parserFields = Object.keys(EnrichmentPayloadSchema.shape).sort();
    expect(wireFields).toEqual(parserFields);
    expect((schema.required as readonly string[]).slice().sort()).toEqual(parserFields);
  });

  test("the wire enum matches the parser enum", () => {
    const schema = enrichmentJsonSchema();
    const properties = schema.properties as Record<string, { enum?: readonly string[] }>;
    expect(properties.recommendation?.enum).toEqual([...RECOMMENDATIONS]);
  });
});
