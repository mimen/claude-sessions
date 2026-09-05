import { expect, test } from "bun:test";
import {
  canonicalModelId,
  claudeCodeModelId,
  claudeModelUsesMillionWindow,
  compileLocationModelLaunch,
  compileModelLaunch,
  compileRoleModelLaunch,
  launcherReachesModel,
  launcherServesFamily,
  launchersServingFamily,
  millionWindowClaudeFamilies,
  parseBirthModel,
  parseLauncherName,
  parseRoleModel,
  unregisteredRoleModelIds,
  type BirthModelId,
  type LauncherName,
  type RoleModelId,
} from "./role-model-launch.ts";

const role = (value: string): RoleModelId => value as RoleModelId;
const birth = (value: string): BirthModelId => value as BirthModelId;

test("parseRoleModel accepts only canonical closed model IDs", () => {
  expect(parseRoleModel("claude-opus-5")).toBe(role("claude-opus-5"));
  expect(parseRoleModel("gpt-5.6-terra")).toBe(role("gpt-5.6-terra"));
  expect(parseRoleModel("gpt-5.6-sol")).toBe(role("gpt-5.6-sol"));
  expect(parseRoleModel("opus")).toBeNull();
  expect(parseRoleModel("gpt-5.6-terra[1m]")).toBeNull();
  expect(parseRoleModel("claude-opus-5-20260101")).toBeNull();
  expect(parseRoleModel(42)).toBeNull();
});

test("the authored role vocabulary is a subset of the registry's birth models", () => {
  expect(unregisteredRoleModelIds()).toEqual([]);
});

test("compileRoleModelLaunch derives launchers and exact model spellings", () => {
  expect(compileRoleModelLaunch(role("claude-opus-5"))).toMatchObject({
    launcher: { binary: "claudex" }, launchModel: "claude-opus-5[1m]",
  });
  expect(compileRoleModelLaunch(role("gpt-5.6-terra"))).toMatchObject({
    launcher: { binary: "claudex" }, launchModel: "gpt-5.6-terra",
  });
  expect(compileRoleModelLaunch(role("gpt-5.6-sol"))).toMatchObject({
    launcher: { binary: "claudex" }, launchModel: "gpt-5.6-sol",
  });
});

test("Claude Code model declarations follow each model family's real window", () => {
  expect(canonicalModelId("claude-opus-5[1m][1m]")).toBe("claude-opus-5");
  expect(millionWindowClaudeFamilies()).toEqual(["claude-fable-", "claude-opus-", "claude-sonnet-"]);
  expect(claudeModelUsesMillionWindow("claude-fable-5-1")).toBe(true);
  expect(claudeModelUsesMillionWindow("claude-opus-4-8[1m]")).toBe(true);
  expect(claudeModelUsesMillionWindow("claude-sonnet-5")).toBe(true);
  expect(claudeModelUsesMillionWindow("claude-haiku-4-5")).toBe(false);
  expect(claudeCodeModelId("claude-fable-5-1")).toBe("claude-fable-5-1[1m]");
  expect(claudeCodeModelId("claude-haiku-4-5[1m]")).toBe("claude-haiku-4-5");
  expect(claudeCodeModelId("gpt-5.6-sol[1m]")).toBe("gpt-5.6-sol");
  // An envelope family gets no marker, and a behaves_as family gets none either: its window comes
  // through the picker mapping, not through a spelling Claude Code would misread.
  expect(claudeCodeModelId("grok-4.6")).toBe("grok-4.6");
  expect(claudeCodeModelId("glm-5.3-flash")).toBe("glm-5.3-flash");
});

test("fresh-birth compiler routes every registry model to the launcher its row names", () => {
  expect(parseBirthModel("claude-fable-5")).toBe(birth("claude-fable-5"));
  expect(parseBirthModel("claude-fable-5-1")).toBe(birth("claude-fable-5-1"));
  expect(parseBirthModel("claude-fable-5-1[1m]")).toBeNull();
  expect(parseRoleModel("claude-fable-5")).toBeNull();
  // A compatibility row declares no launchers of its own and borrows its replacement's.
  expect(compileModelLaunch(birth("claude-fable-5"))).toMatchObject({
    launcher: { name: "claudex", binary: "claudex" }, launchModel: "claude-fable-5[1m]",
  });
  expect(compileModelLaunch(birth("claude-fable-5-1"))).toMatchObject({
    model: "claude-fable-5-1",
    launcher: { name: "claudex", binary: "claudex" },
    launchModel: "claude-fable-5-1[1m]",
  });
  expect(compileModelLaunch(birth("gpt-5.6-sol"))).toMatchObject({
    launcher: { name: "claudex", binary: "claudex" }, launchModel: "gpt-5.6-sol",
  });
  // `launch_effort` on the glue lane, not a special case in this module.
  expect(compileModelLaunch(birth("gpt-5.6-luna"))).toMatchObject({
    launcher: { name: "claudex", binary: "claudex" }, launchModel: "gpt-5.6-luna(low)",
  });
  expect(compileModelLaunch(birth("grok-4.6"))).toMatchObject({
    launcher: { name: "claudex", binary: "claudex" }, launchModel: "grok-4.6",
  });
  expect(parseBirthModel("claude-opus-5")).toBe(birth("claude-opus-5"));
  expect(parseBirthModel("claude-opus-4-8")).toBeNull();
  expect(parseBirthModel("gpt-5.5")).toBeNull();
  expect(parseBirthModel("claude-haiku-4-5-20251001")).toBeNull();
});

test("location compiler validates the exact authored harness-model pair", () => {
  const valid = compileLocationModelLaunch("claudex", "gpt-5.6-sol");
  expect(valid.ok).toBe(true);
  if (valid.ok) expect(valid.value.launchModel).toBe("gpt-5.6-sol");

  const unreachable = compileLocationModelLaunch("claude-native", "gpt-5.6-sol");
  expect(unreachable.ok).toBe(false);
  if (!unreachable.ok) {
    expect(unreachable.error.message).toContain('cannot reach model "gpt-5.6-sol"');
    expect(unreachable.error.message).toContain("claudex");
  }

  const retired = compileLocationModelLaunch("claudex", "gpt-5.5");
  expect(retired.ok).toBe(false);
  if (!retired.ok) expect(retired.error.message).toContain("is unsupported");

  const unknown = compileLocationModelLaunch("claude-x", "gpt-5.6-sol");
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.error.message).toContain("is unknown");

  const luna = compileLocationModelLaunch("claudex", "gpt-5.6-luna");
  expect(luna.ok).toBe(true);
  if (luna.ok) expect(luna.value.launchModel).toBe("gpt-5.6-luna(low)");
});

test("the registry separates provider reachability from exact context envelopes", () => {
  expect(launcherServesFamily("claudex", "claude")).toBe(true);
  expect(launcherServesFamily("claudex", "gpt")).toBe(true);
  expect(launcherServesFamily("claudex", "other")).toBe(true);
  expect(launcherServesFamily("claude-native", "gpt")).toBe(false);
  expect(launchersServingFamily("claude")).toEqual(["claudex", "claude-native"] as LauncherName[]);
  expect(launchersServingFamily("gpt")).toEqual(["claudex"] as LauncherName[]);
  expect(launcherReachesModel("claudex", "gpt-5.6-sol")).toBe(true);
  expect(launcherReachesModel("claudex", "gpt-5.5")).toBe(false);
  expect(launcherReachesModel("claude-native", "gpt-5.6-sol")).toBe(false);
  expect(launcherReachesModel("claude-native", "claude-haiku-4-5-20251001")).toBe(true);
  expect(parseLauncherName("claudex")).toBe("claudex" as LauncherName);
  expect(parseLauncherName("claude-native")).toBe("claude-native" as LauncherName);
  expect(parseLauncherName("claude-x")).toBeNull();
});

test("claudex compiles Claude 1M and GPT-5.6 921K spellings independently", () => {
  const claude = compileLocationModelLaunch("claudex", "claude-opus-5");
  expect(claude.ok).toBe(true);
  if (claude.ok) {
    expect(claude.value.launcher).toMatchObject({ name: "claudex", binary: "claudex" });
    expect(claude.value.launchModel).toBe("claude-opus-5[1m]");
  }

  const gpt = compileLocationModelLaunch("claudex", "gpt-5.6-sol");
  expect(gpt.ok).toBe(true);
  if (gpt.ok) expect(gpt.value.launchModel).toBe("gpt-5.6-sol");
});

test("claude-native takes the canonical Claude spelling verbatim", () => {
  const native = compileLocationModelLaunch("claude-native", "claude-sonnet-5");
  expect(native.ok).toBe(true);
  if (native.ok) {
    expect(native.value.launcher).toMatchObject({ name: "claude-native", binary: "claude-native" });
    expect(native.value.launchModel).toBe("claude-sonnet-5");
  }
});
