import { describe, expect, test } from "bun:test";
import { buildCostRollup, providerFamily } from "./cost-rollup.ts";
import type { SessionRow } from "./index.ts";

function row(
  sessionId: string,
  costUSD: number,
  options: Partial<Pick<SessionRow, "resumeId" | "isSubagent" | "parentSessionId" | "costByModel">> = {},
): SessionRow {
  return {
    sessionId,
    host: "test",
    path: `/tmp/${sessionId}.jsonl`,
    cwd: null,
    projectRoot: "/tmp",
    projectName: "test",
    branch: null,
    version: null,
    firstTs: null,
    lastTs: null,
    msgCount: 0,
    fileSize: 0,
    title: sessionId,
    titleSource: "fallback",
    isSubagent: options.isSubagent ?? false,
    parentSessionId: options.parentSessionId ?? null,
    resumeId: options.resumeId ?? sessionId,
    costUSD,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: options.costByModel ?? {},
    models: [],
    userTurns: 0,
    tickIntervalSec: 0,
  };
}

describe("buildCostRollup", () => {
  test("recursively joins native sidechains and causal auxiliary descendants exactly once", () => {
    const root = row("root", 2, { resumeId: "root-resume", costByModel: { "claude-sonnet-5": 2 } });
    const nativeChild = row("native", 3, {
      isSubagent: true,
      parentSessionId: "root-resume",
      costByModel: { "gpt-5.6": 3 },
    });
    const auxiliary = row("auxiliary", 5, { costByModel: { "claude-opus-4-8": 5 } });
    const grandchild = row("grandchild", 7, { costByModel: { "gpt-5.6": 7 } });

    const result = buildCostRollup(
      [root, nativeChild, auxiliary, grandchild],
      [
        { parentId: "root", sessionId: "auxiliary" },
        { parentId: "auxiliary", sessionId: "grandchild" },
        // The same relation from two mechanisms does not double-count it.
        { parentId: "root", sessionId: "native" },
      ],
    );

    expect(result.bySessionId.get("root")).toEqual({
      selfCost: 2,
      totalCost: 17,
      byProvider: { claude: 7, gpt: 10, other: 0 },
      descendantCount: 3,
      physicalSessionIds: new Set(["root", "native", "auxiliary", "grandchild"]),
    });
    expect(result.physicalStoreCost).toBe(17);
  });

  test("rolls delegated cost into a catalogue-only automation anchor", () => {
    const result = buildCostRollup(
      [
        row("child", 4, { costByModel: { "gpt-5.6-luna": 4 } }),
        row("grandchild", 2, { costByModel: { "claude-opus-4-8": 2 } }),
      ],
      [
        { parentId: "automation-anchor", sessionId: "child" },
        { parentId: "child", sessionId: "grandchild" },
      ],
    );

    expect(result.bySessionId.get("automation-anchor")).toEqual({
      selfCost: 0,
      totalCost: 6,
      byProvider: { claude: 2, gpt: 4, other: 0 },
      descendantCount: 2,
      physicalSessionIds: new Set(["child", "grandchild"]),
    });
    expect(result.physicalStoreCost).toBe(6);
  });

  test("terminates cycles while retaining each physical transcript once", () => {
    const result = buildCostRollup(
      [row("a", 2), row("b", 3)],
      [
        { parentId: "a", sessionId: "b" },
        { parentId: "b", sessionId: "a" },
      ],
    );

    expect(result.bySessionId.get("a")?.totalCost).toBe(5);
    expect(result.bySessionId.get("b")?.totalCost).toBe(5);
    expect(result.physicalStoreCost).toBe(5);
  });

  test("normalizes aliases and preserves scalar costs with absent model data", () => {
    const result = buildCostRollup(
      [row("parent", 1, { resumeId: "parent-resume" }), row("child", 4)],
      [{ parentId: "parent-resume", sessionId: "child" }],
    );

    expect(result.bySessionId.get("parent")?.totalCost).toBe(5);
    expect(result.bySessionId.get("parent")?.byProvider).toEqual({ claude: 0, gpt: 0, other: 5 });
  });
});

test("providerFamily classifies observed served-model identifiers", () => {
  expect(providerFamily("claude-fable-5")).toBe("claude");
  expect(providerFamily("gpt-5.6")).toBe("gpt");
  expect(providerFamily("gemini-3-pro")).toBe("other");
});
