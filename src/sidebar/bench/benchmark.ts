import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildBridge } from "../../cmux/bridge.ts";
import { readCatalogueReadOnly } from "../catalogue-read.ts";
import { readIndexReadOnly } from "../index-read.ts";
import { createSidebarReadCache } from "../read-cache.ts";
import { createSidebarServer } from "../server.ts";
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

export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
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

export interface EtagLoopbackResult {
  readonly initialBodyBytes: number;
  readonly unchanged: {
    readonly statuses: readonly number[];
    readonly bodyBytes: number;
    readonly latencyMs: Distribution;
  };
  readonly staleTrigger: {
    readonly statuses: readonly number[];
    readonly bodyBytes: number;
    readonly latencyMs: Distribution;
  };
  readonly changedVisible: {
    readonly statuses: readonly number[];
    readonly bodyBytes: Distribution;
    readonly latencyMs: Distribution;
  };
}

export interface LivenessCacheResult {
  readonly injectedBridgeDelayMs: number;
  readonly requests: number;
  readonly bridgeReads: number;
  readonly statuses: readonly number[];
  readonly bodyBytes: number;
  readonly latencyMs: Distribution;
  readonly refreshPendingWhenFirstResponseCompleted: boolean;
}

export const SIDEBAR_PERFORMANCE_BUDGETS = {
  contentionSnapshotMs: 120,
  eventLoopMaximumBlockMs: 50,
  unchangedPollP95Ms: 10,
  staleTriggerP95Ms: 10,
  changedVisibleP50Ms: 40,
  changedVisibleP95Ms: 120,
} as const;

export interface SidebarPerformanceBudgetInput {
  readonly contention: ContentionResult;
  readonly etagLoopback: EtagLoopbackResult;
  readonly readPathByteIdentical: boolean;
  readonly logicalStateUnchanged: boolean;
}

function allStatusesAre(statuses: readonly number[], expected: number): boolean {
  return statuses.length > 0 && statuses.every((status) => status === expected);
}

/**
 * Pure evaluator used by the isolated benchmark command; unit suites do not enforce wall-clock
 * budgets because their scheduler contention is unrelated to sidebar performance.
 */
export function sidebarPerformanceBudgetFailures(input: SidebarPerformanceBudgetInput): string[] {
  const failures: string[] = [];
  const { contention, etagLoopback } = input;
  if (contention.snapshotMs >= SIDEBAR_PERFORMANCE_BUDGETS.contentionSnapshotMs) {
    failures.push(
      `contention snapshot ${contention.snapshotMs}ms >= ${SIDEBAR_PERFORMANCE_BUDGETS.contentionSnapshotMs}ms`,
    );
  }
  if (contention.heartbeatLongestDelayMs >= SIDEBAR_PERFORMANCE_BUDGETS.eventLoopMaximumBlockMs) {
    failures.push(
      `event-loop delay ${contention.heartbeatLongestDelayMs}ms >= ${SIDEBAR_PERFORMANCE_BUDGETS.eventLoopMaximumBlockMs}ms`,
    );
  }
  if (!contention.catalogueReadable) failures.push("contention snapshot reported an unreadable catalogue");
  if (etagLoopback.unchanged.latencyMs.p95 >= SIDEBAR_PERFORMANCE_BUDGETS.unchangedPollP95Ms) {
    failures.push(
      `unchanged p95 ${etagLoopback.unchanged.latencyMs.p95}ms >= ${SIDEBAR_PERFORMANCE_BUDGETS.unchangedPollP95Ms}ms`,
    );
  }
  if (!allStatusesAre(etagLoopback.unchanged.statuses, 304)) {
    failures.push("unchanged requests did not all return 304");
  }
  if (etagLoopback.unchanged.bodyBytes !== 0) failures.push("unchanged requests returned body bytes");
  if (etagLoopback.staleTrigger.latencyMs.p95 >= SIDEBAR_PERFORMANCE_BUDGETS.staleTriggerP95Ms) {
    failures.push(
      `stale-trigger p95 ${etagLoopback.staleTrigger.latencyMs.p95}ms >= ${SIDEBAR_PERFORMANCE_BUDGETS.staleTriggerP95Ms}ms`,
    );
  }
  if (!allStatusesAre(etagLoopback.staleTrigger.statuses, 304)) {
    failures.push("stale-trigger requests did not all return 304");
  }
  if (etagLoopback.staleTrigger.bodyBytes !== 0) failures.push("stale-trigger requests returned body bytes");
  if (etagLoopback.changedVisible.latencyMs.p50 >= SIDEBAR_PERFORMANCE_BUDGETS.changedVisibleP50Ms) {
    failures.push(
      `changed-visible p50 ${etagLoopback.changedVisible.latencyMs.p50}ms >= ${SIDEBAR_PERFORMANCE_BUDGETS.changedVisibleP50Ms}ms`,
    );
  }
  if (etagLoopback.changedVisible.latencyMs.p95 >= SIDEBAR_PERFORMANCE_BUDGETS.changedVisibleP95Ms) {
    failures.push(
      `changed-visible p95 ${etagLoopback.changedVisible.latencyMs.p95}ms >= ${SIDEBAR_PERFORMANCE_BUDGETS.changedVisibleP95Ms}ms`,
    );
  }
  if (!allStatusesAre(etagLoopback.changedVisible.statuses, 200)) {
    failures.push("changed-visible requests did not all return 200");
  }
  if (etagLoopback.changedVisible.bodyBytes.min <= 0) {
    failures.push("changed-visible requests returned no representation bytes");
  }
  if (!input.readPathByteIdentical) failures.push("read-path database witnesses changed");
  if (!input.logicalStateUnchanged) failures.push("benchmark fixture logical state changed");
  return failures;
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

/**
 * Normalize only the approved Phase 5 semantic alignment for golden parity.
 *
 * Terminal and parked catalogue rows cannot carry a recommendation disagreement. Every other field
 * remains exact so a wire-shape, ordering, label, or metadata regression still fails the baseline.
 */
export function normalizeRecommendationAlignment(value: JsonValue): JsonValue {
  const normalizeAlignment = (current: JsonValue, key = ""): JsonValue => {
    if (Array.isArray(current)) return current.map((entry) => normalizeAlignment(entry));
    if (current === null || typeof current !== "object") return current;

    const normalized = Object.fromEntries(
      Object.entries(current).map(([entryKey, entry]) => [
        entryKey,
        normalizeAlignment(entry, entryKey),
      ]),
    ) as Record<string, JsonValue>;
    const lifecycle = normalized.lifecycle;
    const catalogueLifecycle = normalized.catalogueLifecycle;
    const settled = lifecycle === "completed" || lifecycle === "archived" || lifecycle === "parked"
      || catalogueLifecycle === "parked";
    if (settled && Object.hasOwn(normalized, "suggestion")) normalized.suggestion = null;

    // Triage is exactly the disagreement subset. Once a settled row's suggestion is removed, the
    // same approved semantic alignment also removes that row from this one derived view.
    if (key === "triage" && Array.isArray(normalized.rows)) {
      normalized.rows = normalized.rows.filter((row) => {
        if (row === null || typeof row !== "object" || Array.isArray(row)) return true;
        const rowLifecycle = row.lifecycle;
        return rowLifecycle !== "completed" && rowLifecycle !== "archived"
          && rowLifecycle !== "parked" && row.catalogueLifecycle !== "parked";
      });
    }
    return normalized;
  };
  return normalizeAlignment(value);
}

function sourceFor(
  fixture: SidebarFixture,
  measurements: SidebarSnapshotMeasurement[],
  overrides: {
    readonly unreadableCatalogue?: boolean;
    readonly unreadableIndex?: boolean;
    readonly unreadableLiveness?: boolean;
    readonly focus?: () => boolean;
    readonly readBridge?: () => Promise<ReturnType<typeof buildBridge>>;
    readonly snapshotLivenessTtlMs?: number;
  } = {},
): SidebarSource {
  const bridge = overrides.unreadableLiveness
    ? buildBridge({ windows: [] }, {}, false)
    : fixture.bridge;
  return createSidebarSource({
    now: () => FIXED_NOW,
    cmuxBin: "benchmark-never-runs-cmux",
    readBridge: overrides.readBridge ?? (async () => bridge),
    ...(overrides.snapshotLivenessTtlMs === undefined
      ? {}
      : { snapshotLivenessTtlMs: overrides.snapshotLivenessTtlMs }),
    ...(overrides.unreadableCatalogue || overrides.unreadableIndex
      ? {
        readCatalogue: overrides.unreadableCatalogue
          ? () => ({ status: "unreadable" as const, error: new Error("fixture catalogue unreadable") })
          : () => readCatalogueReadOnly(fixture.cataloguePath),
        readIndex: overrides.unreadableIndex
          ? () => { throw new Error("fixture index unreadable"); }
          : (_path: string, options: Parameters<typeof readIndexReadOnly>[1]) =>
            readIndexReadOnly(fixture.indexPath, options),
      }
      : { readCache: createSidebarReadCache(fixture.cataloguePath, fixture.indexPath) }),
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

/** Prove a delayed Bridge refresh stays off the conditional-GET response path. */
export async function measureSnapshotLivenessCache(
  fixture: SidebarFixture,
  sampleCount = 30,
  bridgeDelayMs = 75,
): Promise<LivenessCacheResult> {
  let bridgeReads = 0;
  let refreshPending = false;
  const source = sourceFor(fixture, [], {
    snapshotLivenessTtlMs: 60_000,
    readBridge: async () => {
      bridgeReads += 1;
      refreshPending = true;
      await Bun.sleep(bridgeDelayMs);
      refreshPending = false;
      return fixture.bridge;
    },
  });
  const server = createSidebarServer({ source, assets: new Map(), port: 0 });
  const url = `${server.url.origin}/api/snapshot?scope=active&limit=500&include=completed,archived`;
  try {
    const initial = await fetch(url);
    const etag = initial.headers.get("etag");
    await initial.arrayBuffer();
    if (initial.status !== 200 || etag === null) {
      throw new Error("liveness cache benchmark warmup failed");
    }

    const statuses: number[] = [];
    const latencies: number[] = [];
    let bodyBytes = 0;
    let firstPending = false;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const startedAt = performance.now();
      const response = await fetch(url, {
        headers: {
          "if-none-match": etag,
          "x-ccs-refresh-liveness": "1",
        },
      });
      latencies.push(performance.now() - startedAt);
      statuses.push(response.status);
      bodyBytes += (await response.arrayBuffer()).byteLength;
      if (sample === 0) firstPending = refreshPending;
    }
    // Let the forced flight and its one coalesced trailing refresh finish so the counter proves the
    // whole scheduling contract rather than sampling it midway through the first delay.
    await Bun.sleep((bridgeDelayMs * 2) + 10);

    return {
      injectedBridgeDelayMs: bridgeDelayMs,
      requests: sampleCount,
      bridgeReads,
      statuses,
      bodyBytes,
      latencyMs: distribution(latencies),
      refreshPendingWhenFirstResponseCompleted: firstPending,
    };
  } finally {
    server.stop(true);
  }
}

/** Exercise conditional GET through a real loopback Bun server, including serialization and HTTP. */
export async function measureEtagLoopback(
  fixture: SidebarFixture,
  sampleCount = 50,
): Promise<EtagLoopbackResult> {
  const fixtureSource = sourceFor(fixture, []);
  let completedSnapshots = 0;
  let snapshotsInFlight = 0;
  const source: SidebarSource = {
    ...fixtureSource,
    async snapshot(view, rowLimit, include): Promise<SidebarSnapshot> {
      snapshotsInFlight += 1;
      try {
        return await fixtureSource.snapshot(view, rowLimit, include);
      } finally {
        snapshotsInFlight -= 1;
        completedSnapshots += 1;
      }
    },
  };
  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = performance.now() + 2_000;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(`ETag benchmark timed out waiting for ${label}`);
      await Bun.sleep(1);
    }
  };
  const server = createSidebarServer({
    source,
    assets: new Map(),
    port: 0,
    snapshotRepresentationTtlMs: 1,
  });
  const url = `${server.url.origin}/api/snapshot?scope=active&limit=500&include=completed,archived`;
  try {
    const initial = await fetch(url);
    const initialBodyBytes = (await initial.arrayBuffer()).byteLength;
    const initialEtag = initial.headers.get("etag");
    if (initial.status !== 200 || initialEtag === null) throw new Error("ETag benchmark warmup failed");
    let etag: string = initialEtag;

    const unchangedLatencies: number[] = [];
    const unchangedStatuses: number[] = [];
    let unchangedBodyBytes = 0;
    for (let sample = 0; sample < sampleCount; sample += 1) {
      const startedAt = performance.now();
      const response = await fetch(url, { headers: { "if-none-match": etag } });
      unchangedLatencies.push(performance.now() - startedAt);
      unchangedStatuses.push(response.status);
      unchangedBodyBytes += (await response.arrayBuffer()).byteLength;
    }
    await waitFor(() => snapshotsInFlight === 0, "unchanged refresh completion");

    const writer = new Database(fixture.cataloguePath);
    const staleTriggerLatencies: number[] = [];
    const staleTriggerStatuses: number[] = [];
    let staleTriggerBodyBytes = 0;
    const changedVisibleLatencies: number[] = [];
    const changedVisibleStatuses: number[] = [];
    const changedVisibleBodyBytes: number[] = [];
    try {
      for (let sample = 0; sample < Math.max(8, Math.min(sampleCount, 20)); sample += 1) {
        await Bun.sleep(2);
        writer.query(
          `UPDATE catalogue
              SET custom_title = COALESCE(custom_title, session_id) || $suffix
            WHERE session_id = (SELECT session_id FROM catalogue ORDER BY session_id LIMIT 1)`,
        ).run({ $suffix: `-${sample}` });

        const completedBeforeTrigger = completedSnapshots;
        const staleStartedAt = performance.now();
        const stale = await fetch(url, { headers: { "if-none-match": etag } });
        staleTriggerLatencies.push(performance.now() - staleStartedAt);
        staleTriggerStatuses.push(stale.status);
        staleTriggerBodyBytes += (await stale.arrayBuffer()).byteLength;
        await waitFor(
          () => completedSnapshots > completedBeforeTrigger && snapshotsInFlight === 0,
          "stale refresh completion",
        );
        // The source completion precedes the server's synchronous serialization and cache swap.
        await Bun.sleep(0);

        const changedStartedAt = performance.now();
        const changed = await fetch(url, { headers: { "if-none-match": etag } });
        changedVisibleLatencies.push(performance.now() - changedStartedAt);
        changedVisibleStatuses.push(changed.status);
        changedVisibleBodyBytes.push((await changed.arrayBuffer()).byteLength);
        etag = changed.headers.get("etag") ?? etag;
        await waitFor(() => snapshotsInFlight === 0, "changed-visible trailing refresh");
      }
    } finally {
      writer.close();
    }

    return {
      initialBodyBytes,
      unchanged: {
        statuses: unchangedStatuses,
        bodyBytes: unchangedBodyBytes,
        latencyMs: distribution(unchangedLatencies),
      },
      staleTrigger: {
        statuses: staleTriggerStatuses,
        bodyBytes: staleTriggerBodyBytes,
        latencyMs: distribution(staleTriggerLatencies),
      },
      changedVisible: {
        statuses: changedVisibleStatuses,
        bodyBytes: distribution(changedVisibleBodyBytes),
        latencyMs: distribution(changedVisibleLatencies),
      },
    };
  } finally {
    server.stop(true);
  }
}
