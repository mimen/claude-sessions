import {
  MAX_BRIDGE_BENCH_SAMPLES,
  isWorkspaceUuid,
  summarizeFocusedLatencies,
  type BridgeBenchmarkReport,
  type BridgeBenchmarkSample,
  type BridgeBenchmarkTarget,
} from "../bridge-benchmark.ts";
import { postSidebarAction } from "./action-transport.ts";
import { focusWorkspaceRow } from "./focus-bridge.ts";

const BENCH_START_DELAY_MS = 2_000;

interface FocusResponse {
  readonly status: "focused";
}

export interface BridgeBenchmarkConfig {
  readonly samples: number;
  readonly a: string;
  readonly b: string;
}

export type BridgeBenchmarkParamResult =
  | { readonly kind: "inactive" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "ready"; readonly config: BridgeBenchmarkConfig };

function singleParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

/** Parse only the explicit bridge benchmark query; ordinary sidebar URLs stay inert. */
export function parseBridgeBenchmarkParams(url: URL): BridgeBenchmarkParamResult {
  const params = url.searchParams;
  const relevant = ["bench", "samples", "a", "b"];
  if (!relevant.some((name) => params.has(name))) return { kind: "inactive" };

  const bench = singleParam(params, "bench");
  const samplesRaw = singleParam(params, "samples");
  const a = singleParam(params, "a");
  const b = singleParam(params, "b");
  if (bench !== "bridge") {
    return { kind: "invalid", error: "bench must appear exactly once and equal bridge" };
  }
  if (samplesRaw === null || !/^[1-9][0-9]*$/.test(samplesRaw)) {
    return { kind: "invalid", error: "samples must be one positive integer" };
  }
  const samples = Number(samplesRaw);
  if (samples < 1 || samples > MAX_BRIDGE_BENCH_SAMPLES) {
    return {
      kind: "invalid",
      error: `samples must be between 1 and ${MAX_BRIDGE_BENCH_SAMPLES}`,
    };
  }
  if (a === null || !isWorkspaceUuid(a)) {
    return { kind: "invalid", error: "a must be one workspace UUID" };
  }
  if (b === null || !isWorkspaceUuid(b)) {
    return { kind: "invalid", error: "b must be one workspace UUID" };
  }
  if (a === b) return { kind: "invalid", error: "a and b must be different workspace UUIDs" };
  return { kind: "ready", config: { samples, a, b } };
}

function targetFor(index: number): BridgeBenchmarkTarget {
  return index % 2 === 0 ? "a" : "b";
}

async function runBridgeBenchmark(config: BridgeBenchmarkConfig): Promise<BridgeBenchmarkReport> {
  const samples: BridgeBenchmarkSample[] = [];
  let fallbackHttpThunkInvocations = 0;
  const startedAt = new Date().toISOString();

  for (let index = 0; index < config.samples; index += 1) {
    const target = targetFor(index);
    const workspaceId = config[target];
    let sampleFallbacks = 0;
    const sampleStartedAt = performance.now();
    const result = await focusWorkspaceRow({ workspaceId }, async () => {
      fallbackHttpThunkInvocations += 1;
      sampleFallbacks += 1;
      return await postSidebarAction<FocusResponse>(
        "/api/workspace/focus",
        { workspaceId },
      );
    });
    const latencyMs = performance.now() - sampleStartedAt;
    samples.push({
      index,
      target,
      workspaceId,
      outcome: result.outcome,
      latencyMs,
      fallbackHttpInvocations: sampleFallbacks === 0 ? 0 : 1,
    });
  }

  return {
    benchmark: "native-sidebar-focus-bridge",
    samplesRequested: config.samples,
    targets: { a: config.a, b: config.b },
    samples,
    focusedLatencyMs: summarizeFocusedLatencies(samples),
    fallbackHttpThunkInvocations,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

async function postBridgeBenchmarkReport(report: BridgeBenchmarkReport): Promise<void> {
  const response = await fetch("/api/dev/bench-report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
  });
  if (response.status !== 204) {
    throw new Error(`report endpoint returned HTTP ${response.status}`);
  }
}

let benchmarkStarted = false;

/** Arm the one-shot benchmark after the normal React app has mounted and begun polling. */
export function scheduleBridgeBenchmark(url: URL = new URL(window.location.href)): () => void {
  const parsed = parseBridgeBenchmarkParams(url);
  if (parsed.kind === "inactive") return () => {};
  if (parsed.kind === "invalid") {
    console.error(`[CCS bridge benchmark] Invalid query: ${parsed.error}. Benchmark did not run.`);
    return () => {};
  }

  const timer = setTimeout(() => {
    if (benchmarkStarted) return;
    benchmarkStarted = true;
    void runBridgeBenchmark(parsed.config)
      .then(async (report) => {
        await postBridgeBenchmarkReport(report);
        console.info("[CCS bridge benchmark] Report written.", report);
      })
      .catch((cause: object | string) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error(`[CCS bridge benchmark] Failed: ${message}`);
      });
  }, BENCH_START_DELAY_MS);
  return () => clearTimeout(timer);
}
