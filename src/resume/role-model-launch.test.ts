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

test("compileRoleModelLaunch derives launchers and exact model spellings", () => {
  expect(compileRoleModelLaunch("claude-opus-5")).toMatchObject({
    launcher: { binary: "claudex" }, launchModel: "claude-opus-5[1m]",
  });
  expect(compileRoleModelLaunch("gpt-5.6-terra")).toMatchObject({
    launcher: { binary: "claude-gpt" }, launchModel: "gpt-5.6-terra",
  });
  expect(compileRoleModelLaunch("gpt-5.6-sol")).toMatchObject({
    launcher: { binary: "claude-gpt" }, launchModel: "gpt-5.6-sol",
  });
});

test("Claude Code model declarations follow each model family's real window", () => {
  expect(canonicalModelId("claude-opus-5[1m][1m]")).toBe("claude-opus-5");
  expect(claudeModelUsesMillionWindow("claude-fable-5-1")).toBe(true);
  expect(claudeModelUsesMillionWindow("claude-opus-4-8[1m]")).toBe(true);
  expect(claudeModelUsesMillionWindow("claude-sonnet-5")).toBe(true);
  expect(claudeModelUsesMillionWindow("claude-haiku-4-5")).toBe(false);
  expect(claudeCodeModelId("claude-fable-5-1")).toBe("claude-fable-5-1[1m]");
  expect(claudeCodeModelId("claude-haiku-4-5[1m]")).toBe("claude-haiku-4-5");
  expect(claudeCodeModelId("gpt-5.6-sol[1m]")).toBe("gpt-5.6-sol");
});

test("fresh-birth compiler routes every context family to its full-window process", () => {
  expect(parseBirthModel("claude-fable-5")).toBe("claude-fable-5");
  expect(parseBirthModel("claude-fable-5-1")).toBe("claude-fable-5-1");
  expect(parseBirthModel("claude-fable-5-1[1m]")).toBeNull();
  expect(parseRoleModel("claude-fable-5")).toBeNull();
  expect(compileModelLaunch("claude-fable-5")).toMatchObject({
    launcher: { name: "claudex", binary: "claudex" }, launchModel: "claude-fable-5[1m]",
  });
  expect(compileModelLaunch("claude-fable-5-1")).toMatchObject({
    model: "claude-fable-5-1",
    launcher: { name: "claudex", binary: "claudex" },
    launchModel: "claude-fable-5-1[1m]",
  });
  expect(compileModelLaunch("gpt-5.6-sol")).toMatchObject({
    launcher: { name: "claude-gpt", binary: "claude-gpt" }, launchModel: "gpt-5.6-sol",
  });
  expect(compileModelLaunch("gpt-5.6-luna")).toMatchObject({
    launcher: { name: "claude-gpt", binary: "claude-gpt" }, launchModel: "gpt-5.6-luna(low)",
  });
  expect(compileModelLaunch("gpt-5.5")).toMatchObject({
    launcher: { name: "claude-gpt55", binary: "claude-gpt55" }, launchModel: "gpt-5.5",
  });
  expect(compileModelLaunch("qwen3.8-local")).toMatchObject({
    launcher: { name: "local-mlx", binary: "local-mlx" }, launchModel: "qwen3.8-local",
  });
  expect(parseBirthModel("claude-opus-5")).toBe("claude-opus-5");
  expect(parseBirthModel("claude-opus-4-8")).toBeNull();
  expect(parseBirthModel("claude-haiku-4-5-20251001")).toBeNull();
});

test("location compiler validates the exact authored harness-model pair", () => {
  const valid = compileLocationModelLaunch("claude-gpt", "gpt-5.6-sol");
  expect(valid.ok).toBe(true);
  if (valid.ok) expect(valid.value.launchModel).toBe("gpt-5.6-sol");

  const wrongWindow = compileLocationModelLaunch("claude-gpt", "gpt-5.5");
  expect(wrongWindow.ok).toBe(false);
  if (!wrongWindow.ok) {
    expect(wrongWindow.error.message).toContain('cannot reach model "gpt-5.5"');
    expect(wrongWindow.error.message).toContain("claude-gpt55");
  }

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
  if (luna.ok) expect(luna.value.launchModel).toBe("gpt-5.6-luna(low)");
});

test("the launcher table separates provider reachability from exact context envelopes", () => {
  expect(launcherServesFamily("claudex", "claude")).toBe(true);
  expect(launcherServesFamily("claudex", "gpt")).toBe(true);
  expect(launcherServesFamily("local-mlx", "local")).toBe(true);
  expect(launcherServesFamily("claude-native", "gpt")).toBe(false);
  expect(launcherServesFamily("claude-gpt", "claude")).toBe(false);
  expect(launchersServingFamily("claude")).toEqual(["claudex", "claude", "claude-native"]);
  expect(launchersServingFamily("gpt")).toEqual(["claudex", "claude-gpt", "claude-gpt55"]);
  expect(launchersServingFamily("local")).toEqual(["local-mlx"]);
  expect(launcherReachesModel("claudex", "gpt-5.6-sol")).toBe(true);
  expect(launcherReachesModel("claudex", "gpt-5.5")).toBe(false);
  expect(launcherReachesModel("claude-gpt", "gpt-5.5")).toBe(false);
  expect(launcherReachesModel("claude-gpt55", "gpt-5.5")).toBe(true);
  expect(parseLauncherName("claudex")).toBe("claudex");
  expect(parseLauncherName("local-mlx")).toBe("local-mlx");
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
  const native = compileLocationModelLaunch("claude-native", "claude-fable-5");
  expect(native.ok).toBe(true);
  if (native.ok) {
    expect(native.value.launcher).toMatchObject({ name: "claude-native", binary: "claude-native" });
    expect(native.value.launchModel).toBe("claude-fable-5");
  }
});
