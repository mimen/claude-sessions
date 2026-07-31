import { describe, expect, test } from "bun:test";
import { resolveIdPrefix, ambiguousMessage } from "./session-id.ts";

const FULL_A = "0ca6d244-280e-4834-8db0-fc3573ab80da";
const FULL_B = "0c059613-ec1a-4f10-9c2b-2b6a1d4e77aa";
const FULL_C = "7a19d029-2b10-4c3d-8e5f-9a0b1c2d3e4f";

describe("resolveIdPrefix", () => {
  test("full id matches exactly (fast path)", () => {
    const r = resolveIdPrefix([FULL_A, FULL_B, FULL_C], FULL_A);
    expect(r).toEqual({ ok: true, value: FULL_A });
  });

  test("unique prefix resolves to the one match", () => {
    const r = resolveIdPrefix([FULL_A, FULL_B, FULL_C], "7a19d029");
    expect(r).toEqual({ ok: true, value: FULL_C });
  });

  test("even a one-char unique prefix resolves (length is not hardcoded)", () => {
    const r = resolveIdPrefix([FULL_A, FULL_C], "7");
    expect(r).toEqual({ ok: true, value: FULL_C });
  });

  test("ambiguous prefix fails closed and lists sorted candidates", () => {
    // FULL_A and FULL_B both start with "0c"
    const r = resolveIdPrefix([FULL_A, FULL_B, FULL_C], "0c");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("ambiguous");
      if (r.error.kind === "ambiguous") {
        expect(r.error.matches).toEqual([FULL_B, FULL_A].sort());
      }
    }
  });

  test("no match returns kind:none", () => {
    const r = resolveIdPrefix([FULL_A, FULL_B], "ffffffff");
    expect(r).toEqual({ ok: false, error: { kind: "none" } });
  });

  test("empty input is no-match (never matches every candidate)", () => {
    const r = resolveIdPrefix([FULL_A, FULL_B], "");
    expect(r).toEqual({ ok: false, error: { kind: "none" } });
  });

  test("empty candidate list is no-match", () => {
    const r = resolveIdPrefix([], "0ca6");
    expect(r).toEqual({ ok: false, error: { kind: "none" } });
  });

  test("exact match wins over being a prefix of a longer id", () => {
    // input equals FULL_A exactly AND is a prefix of nothing else here
    const r = resolveIdPrefix([FULL_A, `${FULL_A}-shadow`], FULL_A);
    expect(r).toEqual({ ok: true, value: FULL_A });
  });

  test("duplicate candidates collapse (not treated as ambiguous)", () => {
    const r = resolveIdPrefix([FULL_C, FULL_C], "7a19");
    expect(r).toEqual({ ok: true, value: FULL_C });
  });
});

describe("ambiguousMessage", () => {
  test("mentions the input and every candidate", () => {
    const msg = ambiguousMessage("0c", [FULL_A, FULL_B]);
    expect(msg).toContain("0c");
    expect(msg).toContain(FULL_A);
    expect(msg).toContain(FULL_B);
    expect(msg).toContain("2 sessions");
  });
});
