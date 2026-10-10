import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModelRegistry, type ModelRegistry } from "../models/registry.ts";
import {
  liveWindowExpectations,
  liveWindowFindings,
  OUTPUT_RESERVE,
  parseEffectiveWindow,
} from "./live-window.ts";

function registry(): ModelRegistry {
  const loaded = loadModelRegistry(join(import.meta.dir, "..", "models", "fixtures", "models.toml"));
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

test("each picker model expects its real window minus the output reserve", () => {
  const expectations = new Map(liveWindowExpectations(registry(), "claudex").map((e) => [e.model, e]));
  // A marker family: Claude Code knows the 1M id itself.
  expect(expectations.get("claude-opus-5")).toEqual({
    model: "claude-opus-5",
    declaration: "claude-opus-5[1m]",
    expected: 1_000_000 - OUTPUT_RESERVE,
  });
  // A pinned family: Grok is 500K, below the 921K fixture envelope.
  expect(expectations.get("grok-4.6")?.expected).toBe(500_000 - OUTPUT_RESERVE);
  // An envelope family at or above the envelope reads the envelope.
  expect(expectations.get("gpt-5.6-sol")?.expected).toBe(921_000 - OUTPUT_RESERVE);
});

test("the last effectiveWindow in a debug log wins, and a silent log is null", () => {
  const log = [
    "2026-10-09T17:22:20.385Z [DEBUG] [engine] turn 1 start",
    "2026-10-09T17:22:20.390Z [DEBUG] autocompact: tokens=[REDACTED] level=ok effectiveWindow=980000",
    "2026-10-09T17:22:21.000Z [DEBUG] autocompact: tokens=[REDACTED] level=ok effectiveWindow=480000",
  ].join("\n");
  expect(parseEffectiveWindow(log)).toBe(480_000);
  expect(parseEffectiveWindow("nothing here")).toBeNull();
});

test("findings name the direction of a mismatch and a missing line", () => {
  const findings = liveWindowFindings([
    { model: "grok-4.6", declaration: "grok-4.6", expected: 480_000, observed: 980_000 },
    { model: "gpt-6-luna", declaration: "gpt-6-luna", expected: 901_000, observed: 901_000 },
    { model: "glm-5.3-flash", declaration: "glm-5.3-flash", expected: 901_000, observed: null },
  ]);
  expect(findings).toEqual([
    "grok-4.6: accounted 980000, expected 480000 (overrun)",
    "glm-5.3-flash: no effectiveWindow logged; expected 901000",
  ]);
});
