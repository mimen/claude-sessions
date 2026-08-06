/** Temporary evidence schema for the native sidebar focus bridge benchmark. */

export const MAX_BRIDGE_BENCH_SAMPLES = 200;
export const MAX_BRIDGE_BENCH_REPORT_BYTES = 256 * 1024;

export type BridgeBenchmarkTarget = "a" | "b";
export type BridgeBenchmarkOutcome =
  | "focused"
  | "no-bridge"
  | "not-found"
  | "unavailable"
  | "rejected"
  | "timeout"
  | "malformed-reply";

export interface BridgeBenchmarkSample {
  readonly index: number;
  readonly target: BridgeBenchmarkTarget;
  readonly workspaceId: string;
  readonly outcome: BridgeBenchmarkOutcome;
  readonly latencyMs: number;
  readonly fallbackHttpInvocations: 0 | 1;
}

export interface BridgeBenchmarkLatencySummary {
  readonly count: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly max: number | null;
}

export interface BridgeBenchmarkReport {
  readonly benchmark: "native-sidebar-focus-bridge";
  readonly samplesRequested: number;
  readonly targets: {
    readonly a: string;
    readonly b: string;
  };
  readonly samples: readonly BridgeBenchmarkSample[];
  readonly focusedLatencyMs: BridgeBenchmarkLatencySummary;
  readonly fallbackHttpThunkInvocations: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ServerObservedActionPosts {
  readonly open: number;
  readonly workspaceFocus: number;
  readonly total: number;
}

export interface StoredBridgeBenchmarkReport extends BridgeBenchmarkReport {
  readonly serverObservedActionPosts: ServerObservedActionPosts;
}

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BRIDGE_OUTCOMES: readonly BridgeBenchmarkOutcome[] = [
  "focused",
  "no-bridge",
  "not-found",
  "unavailable",
  "rejected",
  "timeout",
  "malformed-reply",
];

export function isWorkspaceUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

export function summarizeFocusedLatencies(
  samples: readonly BridgeBenchmarkSample[],
): BridgeBenchmarkLatencySummary {
  const focused = samples
    .filter((sample) => sample.outcome === "focused")
    .map((sample) => sample.latencyMs)
    .sort((left, right) => left - right);
  if (focused.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, max: null };
  }
  return {
    count: focused.length,
    min: focused[0] ?? null,
    p50: percentile(focused, 0.5),
    p95: percentile(focused, 0.95),
    max: focused[focused.length - 1] ?? null,
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function isBoundedFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120_000;
}

function isOutcome(value: JsonValue | undefined): value is BridgeBenchmarkOutcome {
  return typeof value === "string" && BRIDGE_OUTCOMES.includes(value as BridgeBenchmarkOutcome);
}

function readSummary(value: JsonValue | undefined): BridgeBenchmarkLatencySummary | null {
  if (!isJsonObject(value) || !hasExactKeys(value, ["count", "min", "p50", "p95", "max"])) return null;
  const count = value.count;
  if (!Number.isInteger(count) || typeof count !== "number" || count < 0 || count > MAX_BRIDGE_BENCH_SAMPLES) {
    return null;
  }
  const values = [value.min, value.p50, value.p95, value.max];
  if (!values.every((entry) => entry === null || isBoundedFiniteNumber(entry))) return null;
  if (count === 0 && values.some((entry) => entry !== null)) return null;
  if (count > 0 && values.some((entry) => entry === null)) return null;
  return {
    count,
    min: value.min as number | null,
    p50: value.p50 as number | null,
    p95: value.p95 as number | null,
    max: value.max as number | null,
  };
}

function readSample(value: JsonValue, targets: { readonly a: string; readonly b: string }): BridgeBenchmarkSample | null {
  if (!isJsonObject(value) || !hasExactKeys(value, [
    "index",
    "target",
    "workspaceId",
    "outcome",
    "latencyMs",
    "fallbackHttpInvocations",
  ])) return null;
  const index = value.index;
  const target = value.target;
  const workspaceId = value.workspaceId;
  const fallback = value.fallbackHttpInvocations;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= MAX_BRIDGE_BENCH_SAMPLES) {
    return null;
  }
  if (target !== "a" && target !== "b") return null;
  if (typeof workspaceId !== "string" || workspaceId !== targets[target]) return null;
  if (!isOutcome(value.outcome) || !isBoundedFiniteNumber(value.latencyMs)) return null;
  if (fallback !== 0 && fallback !== 1) return null;
  return {
    index,
    target,
    workspaceId,
    outcome: value.outcome,
    latencyMs: value.latencyMs,
    fallbackHttpInvocations: fallback,
  };
}

export type BridgeBenchmarkReportParseResult =
  | { readonly ok: true; readonly value: BridgeBenchmarkReport }
  | { readonly ok: false; readonly error: string };

/** Validate the evidence payload before it is allowed onto disk. */
export function parseBridgeBenchmarkReport(value: JsonValue): BridgeBenchmarkReportParseResult {
  if (!isJsonObject(value) || !hasExactKeys(value, [
    "benchmark",
    "samplesRequested",
    "targets",
    "samples",
    "focusedLatencyMs",
    "fallbackHttpThunkInvocations",
    "startedAt",
    "completedAt",
  ])) return { ok: false, error: "report has an invalid shape" };
  if (value.benchmark !== "native-sidebar-focus-bridge") {
    return { ok: false, error: "report benchmark is invalid" };
  }
  const samplesRequested = value.samplesRequested;
  if (
    typeof samplesRequested !== "number"
    || !Number.isInteger(samplesRequested)
    || samplesRequested < 1
    || samplesRequested > MAX_BRIDGE_BENCH_SAMPLES
  ) return { ok: false, error: "report sample count is invalid" };
  if (!isJsonObject(value.targets) || !hasExactKeys(value.targets, ["a", "b"])) {
    return { ok: false, error: "report targets are invalid" };
  }
  const a = value.targets.a;
  const b = value.targets.b;
  if (typeof a !== "string" || typeof b !== "string" || !isWorkspaceUuid(a) || !isWorkspaceUuid(b) || a === b) {
    return { ok: false, error: "report targets are invalid" };
  }
  if (!Array.isArray(value.samples) || value.samples.length !== samplesRequested) {
    return { ok: false, error: "report samples are invalid" };
  }
  const targets = { a, b };
  const samples: BridgeBenchmarkSample[] = [];
  for (let index = 0; index < value.samples.length; index += 1) {
    const sampleValue = value.samples[index];
    if (sampleValue === undefined) return { ok: false, error: "report samples are invalid" };
    const sample = readSample(sampleValue, targets);
    if (sample === null || sample.index !== index || sample.target !== (index % 2 === 0 ? "a" : "b")) {
      return { ok: false, error: "report samples are invalid" };
    }
    samples.push(sample);
  }
  const focusedLatencyMs = readSummary(value.focusedLatencyMs);
  if (focusedLatencyMs === null) return { ok: false, error: "report latency summary is invalid" };
  const expectedSummary = summarizeFocusedLatencies(samples);
  if (JSON.stringify(focusedLatencyMs) !== JSON.stringify(expectedSummary)) {
    return { ok: false, error: "report latency summary does not match samples" };
  }
  const fallbackHttpThunkInvocations = value.fallbackHttpThunkInvocations;
  const expectedFallbacks = samples.reduce((total, sample) => total + sample.fallbackHttpInvocations, 0);
  if (fallbackHttpThunkInvocations !== expectedFallbacks) {
    return { ok: false, error: "report fallback count does not match samples" };
  }
  if (
    typeof value.startedAt !== "string"
    || typeof value.completedAt !== "string"
    || value.startedAt.length < 1
    || value.startedAt.length > 64
    || value.completedAt.length < 1
    || value.completedAt.length > 64
  ) return { ok: false, error: "report timestamps are invalid" };
  return {
    ok: true,
    value: {
      benchmark: "native-sidebar-focus-bridge",
      samplesRequested,
      targets,
      samples,
      focusedLatencyMs,
      fallbackHttpThunkInvocations: expectedFallbacks,
      startedAt: value.startedAt,
      completedAt: value.completedAt,
    },
  };
}
