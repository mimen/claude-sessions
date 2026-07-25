import { describe, expect, test } from "bun:test";
import type { Launcher } from "../resume/launchers.ts";
import { routesForSession } from "./session-routes.ts";

const native: Launcher = {
  name: "claude-native",
  binary: "claude-native",
  serves: ["claude-*"],
  env: {},
};
const gpt: Launcher = {
  name: "claude-gpt",
  binary: "claude-gpt",
  serves: ["gpt-*"],
  env: {},
};
const launchers = [native, gpt];
const models = ["claude-opus-5", "gpt-5.6-sol"];

describe("TUI resume routing", () => {
  test("mixed history defaults to GPT when its last turn is GPT", () => {
    const routing = routesForSession(launchers, { models, lastModel: "gpt-5.6-sol" });
    expect(routing.defaultRoute?.launcher.name).toBe("claude-gpt");
    expect(routing.routes.map((route) => route.eligible)).toEqual([false, true]);
  });

  test("mixed history defaults to native when its last turn is Claude", () => {
    const routing = routesForSession(launchers, { models, lastModel: "claude-opus-5" });
    expect(routing.defaultRoute?.launcher.name).toBe("claude-native");
    expect(routing.routes.map((route) => route.eligible)).toEqual([true, false]);
  });
});
