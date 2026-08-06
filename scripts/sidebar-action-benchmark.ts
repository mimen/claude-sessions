import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildBridge } from "../src/cmux/bridge.ts";
import { getRow } from "../src/catalogue/db-queries.ts";
import { distribution } from "../src/sidebar/bench/benchmark.ts";
import { createSidebarFixture, FIXED_NOW } from "../src/sidebar/bench/fixtures.ts";
import type { IndexedSessionInput } from "../src/sidebar/projection.ts";
import { createSidebarSource, type SidebarSourceOptions } from "../src/sidebar/snapshot.ts";

function numberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) throw new Error(`${name} requires a positive number`);
  return Math.trunc(value);
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolver: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => { resolver = resolve; });
  return {
    promise,
    resolve(value: T): void {
      if (!resolver) throw new Error("deferred promise was not initialized");
      resolver(value);
    },
  };
}

function indexed(sessionId: string, resumeId: string): IndexedSessionInput {
  return {
    sessionId,
    resumeId,
    title: "Action benchmark",
    cwd: "/tmp/action-benchmark",
    lastTs: new Date(FIXED_NOW).toISOString(),
    models: ["gpt-5.6-sol"],
    costByModel: {},
  };
}

const samples = numberArgument("--samples", 25);
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0
  ? process.argv[outputIndex + 1]
  : join(import.meta.dir, "..", "docs", "evidence", "sidebar-performance", "phase3-actions.json");
if (!outputPath) throw new Error("--output requires a path");

const temporaryRoot = mkdtempSync(join(tmpdir(), "ccs-sidebar-actions-"));
const fixtureRoot = join(temporaryRoot, "fleet");
const previousRoot = process.env.CCS_ROOT;

try {
  const fixture = createSidebarFixture(fixtureRoot);
  process.env.CCS_ROOT = fixtureRoot;
  const closed = indexed("session-0025", "resume-0025");
  const paintDb = new Database(fixture.cataloguePath, { readonly: true });
  const paintRow = getRow(paintDb, closed.sessionId);
  paintDb.close();
  const emptyBridge = buildBridge({ windows: [] }, {});
  const baseOptions: SidebarSourceOptions = {
    now: () => FIXED_NOW,
    cmuxBin: "benchmark-never-runs-cmux",
    readStatuses: async () => new Map(),
    workspaceStateReader: { read: async () => new Map() },
    notificationReader: { read: async () => ({ notifications: [], unreadCountsByWorkspaceId: new Map() }) },
    directoryFacts: { lookup: async () => ({ checkouts: new Map(), favicons: new Map() }) },
    loadLaunchers: () => ({ ok: true, value: [{ name: "gateway", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] }] }),
    cataloguePath: fixture.cataloguePath,
    ensureDataDir: () => {},
  };

  let focusBridgeReads = 0;
  let focusCommands = 0;
  const focusSource = createSidebarSource({
    ...baseOptions,
    readBridge: async () => {
      focusBridgeReads += 1;
      return fixture.bridge;
    },
    indexedSessions: () => [],
    processAdapter: {
      run: async () => {
        focusCommands += 1;
        return { ok: true, stdout: "", stderr: "", timedOut: false };
      },
    },
  });
  const focusLatencies: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const startedAt = performance.now();
    const outcome = await focusSource.open(fixture.liveSessionId);
    if (outcome.status !== "focused") throw new Error(`focus benchmark returned ${outcome.status}`);
    focusLatencies.push(performance.now() - startedAt);
  }

  const resumeGate = deferred<{
    readonly status: "resumed";
    readonly note: null;
    readonly workspaceRef: string;
  }>();
  const deferredPaint: Array<() => void> = [];
  let resumeCalls = 0;
  let resumeBridgeReads = 0;
  let repeatFocusCommands = 0;
  let paintCalls = 0;
  const resumeSource = createSidebarSource({
    ...baseOptions,
    readBridge: async () => {
      resumeBridgeReads += 1;
      return emptyBridge;
    },
    indexedSessions: () => [closed],
    processAdapter: {
      run: async () => {
        repeatFocusCommands += 1;
        return { ok: true, stdout: "", stderr: "", timedOut: false };
      },
    },
    resumeAction: async () => {
      resumeCalls += 1;
      return { status: "ok", result: await resumeGate.promise, paintRow };
    },
    deferActionTask: (task) => deferredPaint.push(task),
    paintWorkspace: async () => {
      paintCalls += 1;
      throw new Error("synthetic deferred paint failure");
    },
  });

  const resumeStartedAt = performance.now();
  let firstSettled = false;
  const first = resumeSource.open(closed.sessionId).finally(() => { firstSettled = true; });
  const duplicate = resumeSource.open(closed.resumeId);
  for (let attempt = 0; attempt < 100 && resumeCalls !== 1 && !firstSettled; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (resumeCalls !== 1) {
    const outcome = await first;
    throw new Error(`resume did not enter its process seam (${outcome.status})`);
  }
  const bridgeReadsAfterConcurrentOpens = resumeBridgeReads;
  const snapshotStartedAt = performance.now();
  const concurrentSnapshot = await resumeSource.snapshot("active", 50);
  const concurrentSnapshotMs = performance.now() - snapshotStartedAt;
  const bridgeReadsAfterSnapshot = resumeBridgeReads;
  const snapshotRespondedBeforeResume = !firstSettled;
  resumeGate.resolve({ status: "resumed", note: null, workspaceRef: "workspace:500" });
  const firstOutcome = await first;
  const duplicateOutcome = await duplicate;
  const resumeAcknowledgementMs = performance.now() - resumeStartedAt;
  const repeatOutcome = await resumeSource.open(closed.sessionId);
  const paintWasDeferredAtAcknowledgement = paintCalls === 0 && deferredPaint.length === 1;
  deferredPaint[0]?.();
  await Promise.resolve();
  await Promise.resolve();

  const baselinePath = join(import.meta.dir, "..", "docs", "evidence", "sidebar-performance", "baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as {
    readonly fleet: { readonly safeFocus: { readonly latencyMs: { readonly p95: number } } };
  };
  const focus = distribution(focusLatencies);
  const evidence = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: `bun run benchmark:sidebar:actions --samples ${samples}`,
    safety: {
      fixtureRoot: "<os-tmpdir>/ccs-sidebar-actions-*/fleet",
      generatedSqliteOnly: true,
      cmuxProcessesInvoked: false,
      injectedAsyncProcessAdapter: true,
      baselineOverwritten: false,
    },
    focus: {
      samples,
      latencyMs: focus,
      bridgeReads: focusBridgeReads,
      bridgeReadsPerOpen: focusBridgeReads / samples,
      processCommands: focusCommands,
      p95BudgetMs: 150,
      baselineFleetP95Ms: baseline.fleet.safeFocus.latencyMs.p95,
      p95DeltaMs: Math.round((focus.p95 - baseline.fleet.safeFocus.latencyMs.p95) * 1_000) / 1_000,
    },
    resume: {
      acknowledgementMs: Math.round(resumeAcknowledgementMs * 1_000) / 1_000,
      acknowledgementBudgetMs: 700,
      resumeCalls,
      openActions: 3,
      bridgeReadsForConcurrentOpens: bridgeReadsAfterConcurrentOpens,
      bridgeReadsForSnapshot: bridgeReadsAfterSnapshot - bridgeReadsAfterConcurrentOpens,
      bridgeReadsForRepeatOpen: resumeBridgeReads - bridgeReadsAfterSnapshot,
      bridgeReadsPerOpen: (resumeBridgeReads - 1) / 3,
      firstOutcome: firstOutcome.status,
      duplicateOutcome: duplicateOutcome.status,
      repeatOutcome: repeatOutcome.status,
      repeatFocusCommands,
      deferredPaintTasks: deferredPaint.length,
      paintWasDeferredAtAcknowledgement,
      paintCallsAfterDrain: paintCalls,
    },
    concurrency: {
      snapshotMs: Math.round(concurrentSnapshotMs * 1_000) / 1_000,
      snapshotRespondedBeforeResume,
      snapshotLivenessReadable: concurrentSnapshot.livenessReadable,
      maximumRequestBlockBudgetMs: 50,
    },
    assertions: {
      oneBridgeReadPerFocusOpen: focusBridgeReads === samples,
      oneBridgeReadPerResumeOpen: bridgeReadsAfterConcurrentOpens === 2
        && bridgeReadsAfterSnapshot - bridgeReadsAfterConcurrentOpens === 1
        && resumeBridgeReads - bridgeReadsAfterSnapshot === 1,
      singleFlightResume: resumeCalls === 1,
      duplicateFocusedCreatedWorkspace: duplicateOutcome.status === "focused",
      repeatFocusedCreatedWorkspace: repeatOutcome.status === "focused",
      deferredPaintFailureDidNotFailAction: firstOutcome.status === "resumed" && paintCalls === 1,
      focusWithinBudget: focus.p95 < 150,
      resumeWithinBudget: resumeAcknowledgementMs < 700,
      snapshotRespondedWhileResumePending: snapshotRespondedBeforeResume,
      snapshotWithinBlockBudget: concurrentSnapshotMs < 50,
    },
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ outputPath, focus: evidence.focus, resume: evidence.resume, concurrency: evidence.concurrency, assertions: evidence.assertions }, null, 2)}\n`);
} finally {
  if (previousRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = previousRoot;
  rmSync(temporaryRoot, { recursive: true, force: true });
}
