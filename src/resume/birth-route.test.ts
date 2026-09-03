import { expect, test } from "bun:test";
import { compileExactBirthRoute, resolveBirthRoute } from "./birth-route.ts";
import { ok } from "../result.ts";
import type { Launcher } from "./launchers.ts";

const FLEET: readonly Launcher[] = [
  { name: "claudex", binary: "claudex", serves: ["*"], env: {}, clears: [] },
  { name: "claude-native", binary: "claude-native", serves: ["claude-*", "anthropic.*"], env: {}, clears: [] },
  { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] },
];
const registry = () => ok(FLEET);

test("no declared route falls back to the zero-config launcher", () => {
  const route = compileExactBirthRoute({ locationKey: "home" });
  expect(route.ok).toBe(true);
  if (!route.ok) return;
  expect(route.value).toEqual({ launcher: "claude", model: null, launchModel: null });
});

test("--model still derives its own launcher without consulting the registry", () => {
  const gpt = compileExactBirthRoute({ locationKey: "home", model: "gpt-5.6-sol" });
  expect(gpt.ok).toBe(true);
  if (gpt.ok) expect(gpt.value.launcher).toBe("claude-gpt");

  const claude = compileExactBirthRoute({ locationKey: "home", model: "claude-fable-5-1" });
  expect(claude.ok).toBe(true);
  if (claude.ok) {
    expect(claude.value).toEqual({
      launcher: "claudex",
      model: "claude-fable-5-1",
      launchModel: "claude-fable-5-1[1m]",
    });
  }
});

// The fleet-wide daily driver is the location registry's default_harness/default_model pair, so
// repointing it is one line of TOML. That only works if the declared harness survives resolution.
test("a location-declared claudex default survives BOTH compile and resolve", () => {
  const request = {
    locationKey: "home",
    defaultHarness: "claudex",
    defaultModel: "claude-opus-5",
  } as const;

  const exact = compileExactBirthRoute(request);
  expect(exact.ok).toBe(true);
  if (!exact.ok) return;
  expect(exact.value).toEqual({
    launcher: "claudex",
    model: "claude-opus-5",
    launchModel: "claude-opus-5[1m]",
  });

  const resolved = resolveBirthRoute(request, registry);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  // Resolution preserves the registry-authored launcher instead of replacing it with another
  // process envelope that happens to serve the same model.
  expect(resolved.value.launcher).toMatchObject({ name: "claudex", binary: "claudex" });
});

test("repointing the default back to claude-native is the same one-line edit", () => {
  const resolved = resolveBirthRoute(
    { locationKey: "home", defaultHarness: "claude-native", defaultModel: "claude-opus-5" },
    registry,
  );
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value.launcher).toMatchObject({ name: "claude-native", binary: "claude-native" });
  // No gateway, so no [1m] context declaration.
  expect(resolved.value.exact.launchModel).toBe("claude-opus-5");
});

test("a location cannot declare a harness that does not reach its model", () => {
  const bad = compileExactBirthRoute({
    locationKey: "home",
    defaultHarness: "claude-gpt",
    defaultModel: "claude-opus-5",
  });
  expect(bad.ok).toBe(false);
  if (bad.ok) return;
  expect(bad.error.message).toContain("cannot reach model");
});

test("--via resolves against the machine's configured fleet, not the birth table", () => {
  const resolved = resolveBirthRoute({ locationKey: "home", via: "claudex" }, registry);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value.launcher).toBe(FLEET[0]!);
  expect(resolved.value.exact).toEqual({ launcher: "claudex", model: null, launchModel: null });

  const unknown = resolveBirthRoute({ locationKey: "home", via: "nope" }, registry);
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error.message).toContain("claudex, claude-native, claude-gpt");
});
