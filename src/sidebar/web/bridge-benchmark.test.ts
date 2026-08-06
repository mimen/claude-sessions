import { describe, expect, test } from "bun:test";
import {
  summarizeFocusedLatencies,
  type BridgeBenchmarkSample,
} from "../bridge-benchmark.ts";
import { parseBridgeBenchmarkParams } from "./bridge-benchmark.ts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function sample(
  index: number,
  latencyMs: number,
  outcome: BridgeBenchmarkSample["outcome"] = "focused",
): BridgeBenchmarkSample {
  const target = index % 2 === 0 ? "a" : "b";
  return {
    index,
    target,
    workspaceId: target === "a" ? A : B,
    outcome,
    latencyMs,
    fallbackHttpInvocations: outcome === "focused" ? 0 : 1,
  };
}

describe("parseBridgeBenchmarkParams", () => {
  test("leaves ordinary sidebar URLs inactive", () => {
    expect(parseBridgeBenchmarkParams(new URL("http://127.0.0.1:8787/"))).toEqual({
      kind: "inactive",
    });
  });

  test("accepts one bounded sample count and two distinct workspace UUIDs", () => {
    const result = parseBridgeBenchmarkParams(new URL(
      `http://127.0.0.1:8787/?bench=bridge&samples=50&a=${A}&b=${B}`,
    ));
    expect(result).toEqual({ kind: "ready", config: { samples: 50, a: A, b: B } });
  });

  test("rejects missing, duplicate, unbounded, and malformed parameters", () => {
    const queries = [
      `bench=bridge&samples=0&a=${A}&b=${B}`,
      `bench=bridge&samples=201&a=${A}&b=${B}`,
      `bench=bridge&samples=5.5&a=${A}&b=${B}`,
      `bench=bridge&samples=50&a=not-a-uuid&b=${B}`,
      `bench=bridge&samples=50&a=${A}&b=${A}`,
      `bench=bridge&bench=bridge&samples=50&a=${A}&b=${B}`,
      `samples=50&a=${A}&b=${B}`,
    ];
    for (const query of queries) {
      expect(parseBridgeBenchmarkParams(new URL(`http://127.0.0.1:8787/?${query}`)).kind)
        .toBe("invalid");
    }
  });
});

describe("summarizeFocusedLatencies", () => {
  test("computes nearest-rank min, p50, p95, and max from focused samples only", () => {
    const samples = Array.from({ length: 20 }, (_, index) => sample(index, index + 1));
    samples.push(sample(20, 10_000, "unavailable"));

    expect(summarizeFocusedLatencies(samples)).toEqual({
      count: 20,
      min: 1,
      p50: 10,
      p95: 19,
      max: 20,
    });
  });

  test("returns null aggregates when no bridge call focused", () => {
    expect(summarizeFocusedLatencies([sample(0, 12, "no-bridge")])).toEqual({
      count: 0,
      min: null,
      p50: null,
      p95: null,
      max: null,
    });
  });
});
