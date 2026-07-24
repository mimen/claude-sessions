import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LAUNCHERS,
  defaultRoute,
  launcherByName,
  launchersFrom,
  matchesModel,
  resolveRoutes,
  type Launcher,
} from "./launchers.ts";

const claude: Launcher = { name: "claude", binary: "claude", serves: ["*"], env: {} };
const gpt: Launcher = { name: "gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {} };
const native: Launcher = { name: "native", binary: "claude-native", serves: ["*"], env: {} };
const FLEET = [claude, gpt, native];

describe("matchesModel", () => {
  test("* matches anything", () => {
    expect(matchesModel("*", "claude-fable-5")).toBe(true);
    expect(matchesModel("*", "")).toBe(true);
  });
  test("prefix glob", () => {
    expect(matchesModel("gpt-*", "gpt-5.6-sol")).toBe(true);
    expect(matchesModel("gpt-*", "claude-fable-5")).toBe(false);
  });
  test("exact literal", () => {
    expect(matchesModel("gpt-5.5", "gpt-5.5")).toBe(true);
    expect(matchesModel("gpt-5.5", "gpt-5.6-sol")).toBe(false);
  });
  test("suffix and infix globs anchor correctly", () => {
    expect(matchesModel("*-sol", "gpt-5.6-sol")).toBe(true);
    expect(matchesModel("*-sol", "gpt-5.6-sol-x")).toBe(false);
    expect(matchesModel("claude-*-5", "claude-fable-5")).toBe(true);
    expect(matchesModel("claude-*-5", "xclaude-fable-5")).toBe(false);
  });
  test("regex metacharacters are literal", () => {
    expect(matchesModel("gpt-5.5", "gpt-5x5")).toBe(false);
  });
});

describe("launchersFrom", () => {
  test("empty config → default claude-only fleet", () => {
    expect(launchersFrom([])).toEqual([...DEFAULT_LAUNCHERS]);
  });
  test("duplicate names are a config error", () => {
    const res = launchersFrom([claude, { ...gpt, name: "claude" }]);
    expect(res).toHaveProperty("error");
  });
  test("passes entries through", () => {
    expect(launchersFrom(FLEET)).toEqual(FLEET);
  });
});

describe("resolveRoutes", () => {
  test("pure-gpt history: all three eligible", () => {
    const routes = resolveRoutes(FLEET, ["gpt-5.6-sol"]);
    expect(routes.map((r) => r.eligible)).toEqual([true, true, true]);
  });
  test("pure-claude history: gpt ineligible with reason", () => {
    const routes = resolveRoutes(FLEET, ["claude-fable-5"]);
    expect(routes[1]!.eligible).toBe(false);
    expect(routes[1]!.reason).toContain("claude-fable-5");
    expect(routes[1]!.reason).toContain("gpt-*");
    expect(routes[0]!.eligible).toBe(true);
  });
  test("mixed gpt→native history: only catch-all launchers", () => {
    const routes = resolveRoutes(FLEET, ["gpt-5.6-sol", "claude-fable-5"]);
    expect(routes.map((r) => r.eligible)).toEqual([true, false, true]);
  });
  test("empty model set eligible everywhere", () => {
    const routes = resolveRoutes(FLEET, []);
    expect(routes.every((r) => r.eligible)).toBe(true);
  });
});

describe("defaultRoute (origin-backend preference)", () => {
  test("pure-gpt session defaults to the gpt launcher", () => {
    const models = ["gpt-5.6-sol"];
    expect(defaultRoute(resolveRoutes(FLEET, models), models)?.launcher.name).toBe("gpt");
  });
  test("pure-claude session defaults to claude (config order tie-break)", () => {
    const models = ["claude-fable-5"];
    expect(defaultRoute(resolveRoutes(FLEET, models), models)?.launcher.name).toBe("claude");
  });
  test("mixed history defaults to first catch-all", () => {
    const models = ["gpt-5.6-sol", "claude-fable-5"];
    expect(defaultRoute(resolveRoutes(FLEET, models), models)?.launcher.name).toBe("claude");
  });
  test("empty history → first launcher", () => {
    expect(defaultRoute(resolveRoutes(FLEET, []), [])?.launcher.name).toBe("claude");
  });
  test("null when nothing is eligible", () => {
    const models = ["claude-fable-5"];
    expect(defaultRoute(resolveRoutes([gpt], models), models)).toBeNull();
  });
});

describe("launcherByName", () => {
  test("finds and misses", () => {
    expect(launcherByName(FLEET, "gpt")).toBe(gpt);
    expect(launcherByName(FLEET, "nope")).toBeNull();
  });
});
