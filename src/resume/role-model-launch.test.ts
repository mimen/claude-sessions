import { expect, test } from "bun:test";
import { compileRoleModelLaunch, parseRoleModel } from "./role-model-launch.ts";

test("parseRoleModel accepts only canonical closed model IDs", () => {
  expect(parseRoleModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(parseRoleModel("gpt-5.6-terra")).toBe("gpt-5.6-terra");
  expect(parseRoleModel("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(parseRoleModel("opus")).toBeNull();
  expect(parseRoleModel("gpt-5.6-terra[1m]")).toBeNull();
  expect(parseRoleModel("claude-opus-4-8-20260101")).toBeNull();
  expect(parseRoleModel(42)).toBeNull();
});

test("compileRoleModelLaunch derives launchers and launcher model spellings", () => {
  expect(compileRoleModelLaunch("claude-opus-4-8")).toMatchObject({
    launcher: { binary: "claude" }, launchModel: "claude-opus-4-8",
  });
  expect(compileRoleModelLaunch("gpt-5.6-terra")).toMatchObject({
    launcher: { binary: "claude-gpt" }, launchModel: "gpt-5.6-terra[1m]",
  });
  expect(compileRoleModelLaunch("gpt-5.6-sol")).toMatchObject({
    launcher: { binary: "claude-gpt" }, launchModel: "gpt-5.6-sol[1m]",
  });
});
