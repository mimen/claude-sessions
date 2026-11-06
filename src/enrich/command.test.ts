import { describe, expect, test } from "bun:test";
import { parseEnrichArgs } from "./command.ts";

describe("parseEnrichArgs", () => {
  test("keeps flag values separate from an explicit session id", () => {
    expect(parseEnrichArgs(["session-prefix", "--json"])).toEqual({
      ok: true,
      value: {
        mode: "one",
        asJson: true,
        includeAutomation: false,
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
        includeAutomation: false,
        limitRaw: "40",
        concurrencyRaw: "3",
        sessionArg: undefined,
      },
    });
  });

  test("--include-automation is a sweep and list flag", () => {
    const parsed = parseEnrichArgs(["--sweep", "--include-automation"]);
    expect(parsed.ok && parsed.value.includeAutomation).toBe(true);
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
    expect(parseEnrichArgs(["session-id", "--include-automation"]).ok).toBe(false);
  });
});
