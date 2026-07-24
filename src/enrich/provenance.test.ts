import { expect, test, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Enrichment must not mint sessions.
 *
 * The failure this guards against is specific and was observed in the real store before this
 * feature existed: headless model calls made through a harness binary (`claude -p`, `codex`)
 * register as Claude Code sessions, so the store accumulated junk one-line entries — "Reply With
 * OK", "Identify the Running Model ID". Enrichment runs over EVERY top-level session, so a
 * harness-based implementation would have added hundreds of such entries to the very catalogue it
 * exists to make legible, and each new session would itself become enrichable. That is a loop.
 *
 * The structural property that prevents it: enrichment reaches the model by raw HTTP POST only. A
 * fetch cannot create a session. Rather than asserting on behaviour after the fact, this test
 * pins the property at the source level, where the regression would actually be introduced — by
 * someone adding a "just shell out to claude for this one case" branch.
 */

const ENRICH_DIR = join(import.meta.dir);

/** Ways a Bun/Node module can start a process, plus the harness binaries that mint sessions. */
const PROCESS_SPAWNING = [
  /\bBun\.spawn\b/,
  /\bBun\.\$\b/,
  /\bchild_process\b/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
  /\bnode:child_process\b/,
];

const HARNESS_INVOCATION = [
  /["'`]claude["'`]/,
  /claude\s+-p\b/,
  /["'`]codex["'`]/,
  /["'`]claude-gpt["'`]/,
  /["'`]claude-native["'`]/,
];

function enrichSources(): { name: string; source: string }[] {
  return readdirSync(ENRICH_DIR)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => ({ name: file, source: readFileSync(join(ENRICH_DIR, file), "utf8") }));
}

describe("enrichment creates no sessions", () => {
  test("no module in src/enrich spawns a process", () => {
    const offenders: string[] = [];
    for (const { name, source } of enrichSources()) {
      for (const pattern of PROCESS_SPAWNING) {
        if (pattern.test(source)) offenders.push(`${name} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no module in src/enrich invokes a harness binary", () => {
    const offenders: string[] = [];
    for (const { name, source } of enrichSources()) {
      // Comments explain WHY we don't shell out to these, so only weigh executable lines.
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      for (const pattern of HARNESS_INVOCATION) {
        if (pattern.test(code)) offenders.push(`${name} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the enrich modules are not empty — the scan above has something to check", () => {
    // A guard on the guard: a rename that emptied this directory would otherwise make every
    // assertion above pass vacuously forever.
    const sources = enrichSources();
    expect(sources.length).toBeGreaterThanOrEqual(5);
    expect(sources.some((s) => s.name === "gateway.ts")).toBe(true);
  });

  test("the model is reached over HTTP, at the gateway, with a bearer key", () => {
    const gateway = readFileSync(join(ENRICH_DIR, "gateway.ts"), "utf8");
    expect(gateway).toContain("127.0.0.1:8317");
    expect(gateway).toContain("/v1/messages");
    expect(gateway).toMatch(/method:\s*"POST"/);
  });
});
