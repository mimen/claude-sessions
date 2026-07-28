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

// Milad's real fleet: no catch-all launcher, so a mixed history used to disqualify BOTH — which
// is what made a harness swap a one-way door into an unresumable session.
const claudeNative: Launcher = {
  name: "claude-native",
  binary: "claude-native",
  serves: ["claude-*", "anthropic.*"],
  env: {},
};
const claudeGpt: Launcher = { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {} };
const SPLIT_FLEET = [claudeNative, claudeGpt];

describe("routing keys on the last model", () => {
  test("swapped native→gpt session is resumable by the gpt launcher", () => {
    const models = ["claude-opus-5", "gpt-5.6-sol"];
    const routes = resolveRoutes(SPLIT_FLEET, models, "gpt-5.6-sol");
    expect(routes.map((r) => r.eligible)).toEqual([false, true]);
    expect(defaultRoute(routes, models, "gpt-5.6-sol")?.launcher.name).toBe("claude-gpt");
  });

  test("swapped gpt→native session is resumable by the native launcher", () => {
    const models = ["claude-opus-5", "gpt-5.6-sol"];
    const routes = resolveRoutes(SPLIT_FLEET, models, "claude-opus-5");
    expect(routes.map((r) => r.eligible)).toEqual([true, false]);
    expect(defaultRoute(routes, models, "claude-opus-5")?.launcher.name).toBe("claude-native");
  });

  test("an earlier model no longer disqualifies the launcher that can replay the last one", () => {
    const models = ["claude-opus-5", "gpt-5.6-sol"];
    // Same history, no last-model recorded: the old strict verdict, nothing eligible at all.
    expect(resolveRoutes(SPLIT_FLEET, models).every((r) => !r.eligible)).toBe(true);
    expect(defaultRoute(resolveRoutes(SPLIT_FLEET, models), models)).toBeNull();
  });

  test("ineligibility blames the last model, not the whole history", () => {
    const routes = resolveRoutes(SPLIT_FLEET, ["claude-opus-5", "gpt-5.6-sol"], "gpt-5.6-sol");
    expect(routes[0]!.reason).toContain("last model is gpt-5.6-sol");
    expect(routes[0]!.reason).not.toContain("claude-opus-5");
  });

  test("pre-v10 row (no last model) keeps the stricter whole-history verdict", () => {
    const models = ["gpt-5.6-sol", "claude-fable-5"];
    expect(resolveRoutes(FLEET, models, "").map((r) => r.eligible)).toEqual([true, false, true]);
    expect(resolveRoutes(FLEET, models, "")[1]!.reason).toContain("history contains");
  });

  test("last model alone still routes to the most specific launcher", () => {
    const models = ["gpt-5.6-sol"];
    expect(defaultRoute(resolveRoutes(FLEET, models, "gpt-5.6-sol"), models, "gpt-5.6-sol")?.launcher.name).toBe("gpt");
  });

  test("no assistant turns stays eligible everywhere", () => {
    expect(resolveRoutes(SPLIT_FLEET, [], "").every((r) => r.eligible)).toBe(true);
  });
});

describe("launcherByName", () => {
  test("finds and misses", () => {
    expect(launcherByName(FLEET, "gpt")).toBe(gpt);
    expect(launcherByName(FLEET, "nope")).toBeNull();
  });
});

// Milad's fleet after the claudex consolidation: one launcher reaching BOTH vendors, listed first
// as the daily driver, alongside the two single-vendor ones it supersedes.
const claudex: Launcher = { name: "claudex", binary: "claudex", serves: ["*"], env: {} };
const CONSOLIDATED_FLEET = [claudex, claudeNative, claudeGpt];

describe("a both-vendor launcher alongside single-vendor ones", () => {
  test("claudex is eligible for every history, including the mixed ones that stranded the pair", () => {
    const mixed = ["claude-opus-5", "gpt-5.6-sol"];
    // No last model recorded (pre-v10 row): the strict whole-history verdict used to disqualify
    // BOTH launchers, which is what made a harness swap a one-way door.
    const routes = resolveRoutes(CONSOLIDATED_FLEET, mixed, "");
    expect(routes.map((r) => r.eligible)).toEqual([true, false, false]);
    expect(defaultRoute(routes, mixed, "")?.launcher.name).toBe("claudex");
  });

  test("origin-backend preference still beats the catch-all for a single-vendor history", () => {
    // This is what keeps swap-harness able to name the harness a session came from: a `*` launcher
    // sitting first in config order must not swallow every default.
    const claude = ["claude-opus-5"];
    expect(defaultRoute(resolveRoutes(CONSOLIDATED_FLEET, claude, "claude-opus-5"), claude, "claude-opus-5")
      ?.launcher.name).toBe("claude-native");

    const gptOnly = ["gpt-5.6-sol"];
    expect(defaultRoute(resolveRoutes(CONSOLIDATED_FLEET, gptOnly, "gpt-5.6-sol"), gptOnly, "gpt-5.6-sol")
      ?.launcher.name).toBe("claude-gpt");
  });

  test("a session with no assistant turns yet defaults to the first-listed launcher", () => {
    // Config ORDER is the only tie-break with nothing to route on, which is how `claudex` becomes
    // the daily driver without touching the specificity rule above.
    expect(defaultRoute(resolveRoutes(CONSOLIDATED_FLEET, [], ""), [], "")?.launcher.name).toBe("claudex");
  });

  test("three named launchers all load, and none of them shadows another", () => {
    const loaded = launchersFrom(CONSOLIDATED_FLEET);
    expect(loaded).toEqual(CONSOLIDATED_FLEET);
    expect(launcherByName(CONSOLIDATED_FLEET, "claudex")).toBe(claudex);
    expect(launcherByName(CONSOLIDATED_FLEET, "claude-native")).toBe(claudeNative);
    expect(launcherByName(CONSOLIDATED_FLEET, "claude-gpt")).toBe(claudeGpt);
  });
});
