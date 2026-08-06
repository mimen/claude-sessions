import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildBridge } from "../../cmux/bridge.ts";
import { readCatalogueReadOnly } from "../catalogue-read.ts";
import { readIndexReadOnly } from "../index-read.ts";
import {
  createSidebarSource,
  type SidebarSnapshotMeasurement,
  type SidebarSource,
} from "../snapshot.ts";
import type { SidebarSnapshot, SidebarView } from "../projection.ts";
import { FIXED_NOW, type SidebarFixture } from "./fixtures.ts";

interface Distribution {
  readonly samples: readonly number[];
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly mean: number;
}

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface DatabaseWitness {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly walExists: boolean;
  readonly walBytes: number | null;
  readonly walSha256: string | null;
  readonly shmExists: boolean;
  readonly userVersion: number;
  readonly schemaSha256: string;
}

export interface CharacterizationResult {
  readonly snapshots: Readonly<Record<string, JsonValue>>;
  readonly snapshotLatencyMs: Readonly<Record<SidebarView, Distribution>>;
  readonly payloadBytes: Readonly<Record<SidebarView, Distribution>>;
  readonly serializationMs: Readonly<Record<SidebarView, Distribution>>;
  readonly seamTimingsMs: Readonly<Record<string, Distribution>>;
  readonly safeFocus: {
    readonly latencyMs: Distribution;
    readonly focusCalls: number;
    readonly outcomes: readonly string[];
  };
}

export interface ContentionResult {
  readonly snapshotMs: number;
  readonly heartbeatTicks: number;
  readonly heartbeatLongestDelayMs: number;
  readonly catalogueReadable: boolean;
}

export interface IdleProfileResult {
  readonly durationMs: number;
  readonly polls: number;
  readonly payloadBytes: number;
  readonly heartbeatTicks: number;
  readonly heartbeatLongestDelayMs: number;
  readonly pollLatencyMs: Distribution;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) throw new Error("cannot summarize an empty sample");
  const samples = [...values].sort((left, right) => left - right).map(rounded);
  const percentile = (fraction: number): number => {
    const index = Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1);
    return samples[index] ?? 0;
  };
  return {
    samples,
    min: samples[0] ?? 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: samples[samples.length - 1] ?? 0,
    mean: rounded(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

export function witnessDatabase(path: string, root: string): DatabaseWitness {
  const bytes = readFileSync(path);
  const walPath = `${path}-wal`;
  const walExists = existsSync(walPath);
  const wal = walExists ? readFileSync(walPath) : null;
  const db = new Database(path, { readonly: true });
  try {
    const userVersion = (db.query("PRAGMA user_version").get() as { readonly user_version: number })
      .user_version;
    const schema = db.query(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    ).all();
    return {
      path: path.replaceAll(root, "<fixture-root>"),
      bytes: statSync(path).size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      walExists,
      walBytes: wal?.byteLength ?? null,
      walSha256: wal ? createHash("sha256").update(wal).digest("hex") : null,
      shmExists: existsSync(`${path}-shm`),
      userVersion,
      schemaSha256: createHash("sha256").update(JSON.stringify(schema)).digest("hex"),
    };
  } finally {
    db.close();
  }
}

function normalize(value: JsonValue, root: string, key = ""): JsonValue {
  if (key === "generatedAt") return 0;
  if (typeof value === "string") return value.replaceAll(root, "<fixture-root>");
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        normalize(entryValue, root, entryKey),
      ]),
    );
  }
  return value;
}

export function normalizeSnapshot(snapshot: SidebarSnapshot, root: string): JsonValue {
  return normalize(JSON.parse(JSON.stringify(snapshot)) as JsonValue, root);
}

function sourceFor(
  fixture: SidebarFixture,
  measurements: SidebarSnapshotMeasurement[],
  overrides: {
    readonly unreadableCatalogue?: boolean;
    readonly unreadableIndex?: boolean;
    readonly unreadableLiveness?: boolean;
    readonly focus?: () => boolean;
  } = {},
): SidebarSource {
  const bridge = overrides.unreadableLiveness
    ? buildBridge({ windows: [] }, {}, false)
    : fixture.bridge;
  return createSidebarSource({
    now: () => FIXED_NOW,
    cmuxBin: "benchmark-never-runs-cmux",
    readBridge: async () => bridge,
    readCatalogue: overrides.unreadableCatalogue
      ? () => ({ status: "unreadable", error: new Error("fixture catalogue unreadable") })
      : () => readCatalogueReadOnly(fixture.cataloguePath),
    readIndex: overrides.unreadableIndex
      ? () => { throw new Error("fixture index unreadable"); }
      : (_path, options) => readIndexReadOnly(fixture.indexPath, options),
    ensureDataDir: () => {},
    statusReader: {
      read: async (workspaceIds) => new Map(workspaceIds.map((workspaceId, index) => [
        workspaceId,
        index % 3 === 0
          ? { state: "published" as const, status: { label: "Needs input", icon: null, color: null } }
          : { state: "published" as const, status: { label: "Running", icon: null, color: null } },
      ])),
    },
    workspaceStateReader: { read: async () => new Map() },
    notificationReader: {
      read: async () => ({ notifications: [], unreadCountsByWorkspaceId: new Map() }),
    },
    directoryFacts: {
      lookup: async (directories) => ({
        checkouts: new Map(directories.map((directory) => [directory, {
          project: directory.split("/").at(-1) ?? directory,
          worktree: null,
          branch: "fixture",
        }])),
        favicons: new Map(),
      }),
    },
    processAdapter: {
      run: async (_file, args) => {
        if (args[0] === "select-workspace") overrides.focus?.();
        return { ok: true, stdout: "", stderr: "", timedOut: false };
      },
    },
    observeSnapshot: (measurement) => measurements.push(measurement),
  });
}

export async function characterizeFixture(
  fixture: SidebarFixture,
  sampleCount = 8,
  captureSnapshots = true,
): Promise<CharacterizationResult> {
  const measurements: SidebarSnapshotMeasurement[] = [];
  const source = sourceFor(fixture, measurements);
  const views: readonly SidebarView[] = ["active", "triage", "completed", "archived"];
  const latency = new Map<SidebarView, number[]>();
  const payload = new Map<SidebarView, number[]>();
  const serialization = new Map<SidebarView, number[]>();
  const snapshots: Record<string, JsonValue> = {};

  for (const view of views) {
    latency.set(view, []);
    payload.set(view, []);
    serialization.set(view, []);
    for (let sample = 0; sample < sampleCount + 2; sample += 1) {
      const startedAt = performance.now();
      const snapshot = await source.snapshot(view, 500, ["completed", "archived"]);
      const snapshotMs = performance.now() - startedAt;
      const serializationStartedAt = performance.now();
      const body = JSON.stringify(snapshot);
      const serializationMs = performance.now() - serializationStartedAt;
      if (sample >= 2) {
        latency.get(view)?.push(snapshotMs);
        payload.get(view)?.push(Buffer.byteLength(body));
        serialization.get(view)?.push(serializationMs);
      }
      if (captureSnapshots && sample === sampleCount + 1) {
        snapshots[view] = normalizeSnapshot(snapshot, fixture.root);
      }
    }
  }

  if (captureSnapshots) {
    snapshots.unreadableCatalogue = normalizeSnapshot(
      await sourceFor(fixture, [], { unreadableCatalogue: true }).snapshot("active", 500),
      fixture.root,
    );
    snapshots.unreadableIndex = normalizeSnapshot(
      await sourceFor(fixture, [], { unreadableIndex: true }).snapshot("active", 500),
      fixture.root,
    );
    snapshots.unreadableLiveness = normalizeSnapshot(
      await sourceFor(fixture, [], { unreadableLiveness: true }).snapshot("active", 500),
      fixture.root,
    );
  }

  let focusCalls = 0;
  const focusSource = sourceFor(fixture, [], {
    focus: () => {
      focusCalls += 1;
      return true;
    },
  });
  const focusLatencies: number[] = [];
  const outcomes: string[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const startedAt = performance.now();
    const outcome = await focusSource.open(fixture.liveSessionId);
    focusLatencies.push(performance.now() - startedAt);
    outcomes.push(outcome.status);
  }

  const phaseValues = new Map<string, number[]>();
  for (const measurement of measurements.slice(views.length * 2)) {
    for (const [phase, duration] of Object.entries(measurement.phases)) {
      const values = phaseValues.get(phase) ?? [];
      values.push(duration);
      phaseValues.set(phase, values);
    }
  }

  return {
    snapshots,
    snapshotLatencyMs: Object.fromEntries(views.map((view) => [view, distribution(latency.get(view) ?? [])])) as Record<SidebarView, Distribution>,
    payloadBytes: Object.fromEntries(views.map((view) => [view, distribution(payload.get(view) ?? [])])) as Record<SidebarView, Distribution>,
    serializationMs: Object.fromEntries(views.map((view) => [view, distribution(serialization.get(view) ?? [])])) as Record<SidebarView, Distribution>,
    seamTimingsMs: Object.fromEntries([...phaseValues].map(([phase, values]) => [phase, distribution(values)])),
    safeFocus: { latencyMs: distribution(focusLatencies), focusCalls, outcomes },
  };
}

interface Heartbeat {
  stop(): { readonly ticks: number; readonly longestDelayMs: number };
}

function startHeartbeat(intervalMs = 10): Heartbeat {
  let ticks = 0;
  let expectedAt = performance.now() + intervalMs;
  let longestDelayMs = 0;
  const timer = setInterval(() => {
    const current = performance.now();
    longestDelayMs = Math.max(longestDelayMs, current - expectedAt);
    expectedAt = current + intervalMs;
    ticks += 1;
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return { ticks, longestDelayMs: rounded(longestDelayMs) };
    },
  };
}

async function waitForLockReady(process: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<void> {
  const reader = process.stdout.getReader();
  const chunk = await reader.read();
  reader.releaseLock();
  if (chunk.done || new TextDecoder().decode(chunk.value).trim() !== "ready") {
    throw new Error("writer-lock fixture did not become ready");
  }
}

export async function measureContention(
  fixture: SidebarFixture,
  holdMs = 5_500,
): Promise<ContentionResult> {
  const holderPath = join(import.meta.dir, "hold-writer-lock.ts");
  const holder = Bun.spawn([process.execPath, holderPath, fixture.cataloguePath, String(holdMs)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  await waitForLockReady(holder);
  const heartbeat = startHeartbeat();
  const startedAt = performance.now();
  const snapshot = await sourceFor(fixture, []).snapshot("active", 500);
  const snapshotMs = performance.now() - startedAt;
  const heartbeatResult = heartbeat.stop();
  await holder.exited;
  return {
    snapshotMs: rounded(snapshotMs),
    heartbeatTicks: heartbeatResult.ticks,
    heartbeatLongestDelayMs: heartbeatResult.longestDelayMs,
    catalogueReadable: snapshot.catalogueReadable,
  };
}

export async function measureIdleProfile(
  fixture: SidebarFixture,
  durationMs: number,
): Promise<IdleProfileResult> {
  const source = sourceFor(fixture, []);
  const heartbeat = startHeartbeat();
  const latencies: number[] = [];
  let payloadBytes = 0;
  let polls = 0;
  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
    const pollStartedAt = performance.now();
    const snapshot = await source.snapshot("active", 500, ["completed", "archived"]);
    latencies.push(performance.now() - pollStartedAt);
    payloadBytes += Buffer.byteLength(JSON.stringify(snapshot));
    polls += 1;
    const remaining = Math.min(1_000, durationMs - (performance.now() - startedAt));
    if (remaining > 0) await Bun.sleep(remaining);
  }
  const heartbeatResult = heartbeat.stop();
  return {
    durationMs,
    polls,
    payloadBytes,
    heartbeatTicks: heartbeatResult.ticks,
    heartbeatLongestDelayMs: heartbeatResult.longestDelayMs,
    pollLatencyMs: distribution(latencies),
  };
}
