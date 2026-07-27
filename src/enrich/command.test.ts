import { describe, expect, test } from "bun:test";
import { parseEnrichArgs } from "./command.ts";

describe("parseEnrichArgs", () => {
  test("keeps flag values separate from an explicit session id", () => {
    expect(parseEnrichArgs(["session-prefix", "--json"])).toEqual({
      ok: true,
      value: {
        mode: "one",
        asJson: true,
        limitRaw: undefined,
        concurrencyRaw: undefined,
        sessionArg: "session-prefix",
      },
    });
    expect(parseEnrichArgs(["--sweep", "--limit", "40", "--concurrency", "3"])).toEqual({
      ok: true,
      value: {
        mode: "sweep",
        asJson: false,
        limitRaw: "40",
        concurrencyRaw: "3",
        sessionArg: undefined,
      },
    });
  });

  test("refuses mode-only flag values instead of treating them as session prefixes", () => {
    const parsed = parseEnrichArgs(["--limit", "3"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("require --sweep or --list");
  });

  test("refuses unknown flags and mixed positional sweep targets", () => {
    expect(parseEnrichArgs(["--typo"]).ok).toBe(false);
    expect(parseEnrichArgs(["session-id", "--sweep"]).ok).toBe(false);
    expect(parseEnrichArgs(["--list", "--concurrency", "2"]).ok).toBe(false);
  });
});
