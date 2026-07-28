import { expect, test } from "bun:test";
import {
  compileLocationModelLaunch,
  compileModelLaunch,
  compileRoleModelLaunch,
  launcherServesFamily,
  launchersServingFamily,
  parseBirthModel,
  parseLauncherName,
  parseRoleModel,
} from "./role-model-launch.ts";

test("parseRoleModel accepts only canonical closed model IDs", () => {
  expect(parseRoleModel("claude-opus-5")).toBe("claude-opus-5");
  expect(parseRoleModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
  expect(parseRoleModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(parseRoleModel("opus")).toBeNull();
  expect(parseRoleModel("gpt-5.6-terra[1m]")).toBeNull();
  expect(parseRoleModel("claude-opus-5-20260101")).toBeNull();
  expect(parseRoleModel(42)).toBeNull();
});

test("compileRoleModelLaunch derives launchers and launcher model spellings", () => {
  expect(compileRoleModelLaunch("claude-opus-5")).toMatchObject({
    launcher: { binary: "claude" }, launchModel: "claude-opus-5",
  });
  expect(compileRoleModelLaunch("gpt-5.6-terra")).toMatchObject({
    launcher: { binary: "claude-gpt" }, launchModel: "gpt-5.6-terra[1m]",
  });
  expect(compileRoleModelLaunch("gpt-5.6-sol")).toMatchObject({
    launcher: { binary: "claude-gpt" }, launchModel: "gpt-5.6-sol[1m]",
  });
});

test("fresh-birth compiler supports curated location models without widening role policy", () => {
  expect(parseBirthModel("claude-fable-5")).toBe("claude-fable-5");
  expect(parseRoleModel("claude-fable-5")).toBeNull();
  expect(compileModelLaunch("claude-fable-5")).toMatchObject({
    launcher: { name: "claude", binary: "claude" }, launchModel: "claude-fable-5",
  });
  expect(compileModelLaunch("gpt-5.6-sol")).toMatchObject({
    launcher: { name: "claude-gpt", binary: "claude-gpt" }, launchModel: "gpt-5.6-sol[1m]",
  });
  expect(compileModelLaunch("gpt-5.6-luna")).toMatchObject({
    launcher: { name: "claude-gpt", binary: "claude-gpt" }, launchModel: "gpt-5.6-luna(low)[1m]",
  });
  expect(parseBirthModel("claude-opus-5")).toBe("claude-opus-5");
  expect(parseBirthModel("claude-opus-4-8")).toBeNull();
  expect(parseBirthModel("claude-haiku-4-5-20251001")).toBeNull();
});

test("location compiler validates the authored harness-model pair", () => {
  const valid = compileLocationModelLaunch("claude-gpt", "gpt-5.6-sol");
  expect(valid.ok).toBe(true);
  if (valid.ok) expect(valid.value.launchModel).toBe("gpt-5.6-sol[1m]");

  const unreachable = compileLocationModelLaunch("claude", "gpt-5.6-sol");
  expect(unreachable.ok).toBe(false);
  if (!unreachable.ok) {
    expect(unreachable.error.message).toContain('cannot reach model "gpt-5.6-sol"');
    expect(unreachable.error.message).toContain("claudex, claude-gpt");
  }

  const unknown = compileLocationModelLaunch("claude-x", "gpt-5.6-sol");
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error.message).toContain("is unknown");

  const luna = compileLocationModelLaunch("claude-gpt", "gpt-5.6-luna");
  expect(luna.ok).toBe(true);
  if (luna.ok) expect(luna.value.launchModel).toBe("gpt-5.6-luna(low)[1m]");
});

// --- claudex: one launcher, both vendors -----------------------------------------

test("the launcher table is the single authority on which vendors a launcher reaches", () => {
  expect(launcherServesFamily("claudex", "claude")).toBe(true);
  expect(launcherServesFamily("claudex", "gpt")).toBe(true);
  expect(launcherServesFamily("claude-native", "gpt")).toBe(false);
  expect(launcherServesFamily("claude-gpt", "claude")).toBe(false);
  expect(launchersServingFamily("claude")).toEqual(["claudex", "claude", "claude-native"]);
  expect(launchersServingFamily("gpt")).toEqual(["claudex", "claude-gpt"]);
  expect(parseLauncherName("claudex")).toBe("claudex");
  expect(parseLauncherName("claude-x")).toBeNull();
});

test("a location may declare claudex for EITHER vendor, and gets the gateway model spelling", () => {
  const claude = compileLocationModelLaunch("claudex", "claude-opus-5");
  expect(claude.ok).toBe(true);
  if (claude.ok) {
    expect(claude.value.launcher).toMatchObject({ name: "claudex", binary: "claudex" });
    // The gateway needs the [1m] context declaration on a full ID; claude-native does not.
    expect(claude.value.launchModel).toBe("claude-opus-5[1m]");
  }

  const gpt = compileLocationModelLaunch("claudex", "gpt-5.6-sol");
  expect(gpt.ok).toBe(true);
  if (gpt.ok) expect(gpt.value.launchModel).toBe("gpt-5.6-sol[1m]");
});

test("claude-native is authorable as a harness and takes the canonical spelling verbatim", () => {
  const native = compileLocationModelLaunch("claude-native", "claude-fable-5");
  expect(native.ok).toBe(true);
  if (native.ok) {
    expect(native.value.launcher).toMatchObject({ name: "claude-native", binary: "claude-native" });
    expect(native.value.launchModel).toBe("claude-fable-5");
  }
});

test("a model with NO declared harness still compiles to the pre-claudex default", () => {
  // Moving the fleet onto claudex is an explicit default_harness decision, never a silent rewrite.
  expect(compileModelLaunch("claude-opus-5").launcher.name).toBe("claude");
  expect(compileModelLaunch("gpt-5.6-sol").launcher.name).toBe("claude-gpt");
});
