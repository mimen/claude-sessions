import { expect, test } from "bun:test";
import {
  compileLocationModelLaunch,
  compileModelLaunch,
  compileRoleModelLaunch,
  parseBirthModel,
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

  const mismatch = compileLocationModelLaunch("claude", "gpt-5.6-sol");
  expect(mismatch.ok).toBe(false);
  if (!mismatch.ok) expect(mismatch.error.message).toContain('expected "claude-gpt"');

  const luna = compileLocationModelLaunch("claude-gpt", "gpt-5.6-luna");
  expect(luna.ok).toBe(true);
  if (luna.ok) expect(luna.value.launchModel).toBe("gpt-5.6-luna(low)[1m]");
});
