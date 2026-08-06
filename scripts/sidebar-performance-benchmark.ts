import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  characterizeFixture,
  measureContention,
  measureIdleProfile,
  witnessDatabase,
} from "../src/sidebar/bench/benchmark.ts";
import {
  createSidebarFixture,
  FIXED_NOW,
  FLEET_SESSION_COUNT,
  LIVE_SESSION_COUNT,
  inspectDatabase,
} from "../src/sidebar/bench/fixtures.ts";

function numberArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const raw = process.argv[index + 1];
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} requires a positive number`);
  }
  return parsed;
}

const samples = Math.trunc(numberArgument("--samples", 8));
const idleMs = Math.trunc(numberArgument("--idle-ms", 60_000));
const contentionMs = Math.trunc(numberArgument("--contention-ms", 5_500));
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0
  ? process.argv[outputIndex + 1]
  : join(import.meta.dir, "..", "docs", "evidence", "sidebar-performance", "baseline.json");
if (!outputPath) throw new Error("--output requires a path");

const temporaryRoot = mkdtempSync(join(tmpdir(), "ccs-sidebar-performance-"));
const goldenRoot = join(temporaryRoot, "golden");
const fleetRoot = join(temporaryRoot, "fleet");
const previousRoot = process.env.CCS_ROOT;

try {
  const golden = createSidebarFixture(goldenRoot, { sessionCount: 8, liveSessionCount: 2 });
  const fleet = createSidebarFixture(fleetRoot);
  process.env.CCS_ROOT = fleetRoot;

  const before = {
    catalogue: witnessDatabase(fleet.cataloguePath, fleet.root),
    index: witnessDatabase(fleet.indexPath, fleet.root),
    catalogueState: inspectDatabase(fleet.cataloguePath),
    indexState: inspectDatabase(fleet.indexPath),
  };

  const goldenCharacterization = await characterizeFixture(golden, Math.max(3, Math.min(samples, 5)));
  process.env.CCS_ROOT = fleetRoot;
  const fleetCharacterization = await characterizeFixture(fleet, samples, false);
  const afterCharacterization = {
    catalogue: witnessDatabase(fleet.cataloguePath, fleet.root),
    index: witnessDatabase(fleet.indexPath, fleet.root),
    catalogueState: inspectDatabase(fleet.cataloguePath),
    indexState: inspectDatabase(fleet.indexPath),
  };
  const contention = await measureContention(fleet, contentionMs);
  const idleProfile = await measureIdleProfile(fleet, idleMs);

  const after = {
    catalogue: witnessDatabase(fleet.cataloguePath, fleet.root),
    index: witnessDatabase(fleet.indexPath, fleet.root),
    catalogueState: inspectDatabase(fleet.cataloguePath),
    indexState: inspectDatabase(fleet.indexPath),
  };

  const baseline = {
    schemaVersion: 1,
    generatedAt: new Date(FIXED_NOW).toISOString(),
    command: `bun run benchmark:sidebar --samples ${samples} --idle-ms ${idleMs} --contention-ms ${contentionMs}`,
    safety: {
      fixtureRoot: "<os-tmpdir>/ccs-sidebar-performance-*/fleet",
      generatedSqliteOnly: true,
      liveCatalogueRead: false,
      liveIndexRead: false,
      cmuxProcessesInvoked: false,
      cmuxFocusInvoked: false,
      cleanupUnderTmpdir: true,
    },
    fixture: {
      golden: { sessions: 8, liveSessions: 2 },
      fleet: { sessions: FLEET_SESSION_COUNT, liveSessions: LIVE_SESSION_COUNT },
      fixedClockEpochMs: FIXED_NOW,
      sampleCount: samples,
    },
    databaseWitness: {
      before,
      afterCharacterization,
      after,
      readPathByteIdentical: JSON.stringify(before) === JSON.stringify(afterCharacterization),
      logicalStateUnchanged: JSON.stringify({
        catalogueState: before.catalogueState,
        indexState: before.indexState,
      }) === JSON.stringify({
        catalogueState: after.catalogueState,
        indexState: after.indexState,
      }),
    },
    golden: goldenCharacterization,
    fleet: fleetCharacterization,
    contention,
    idleProfile,
    expectedPhase1Gates: {
      writerLockSnapshotMs: 120,
      eventLoopMaximumBlockMs: 50,
      changedWarmSnapshotP50Ms: 40,
      changedWarmSnapshotP95Ms: 120,
      liveFocusP95Ms: 150,
    },
    limitations: [
      "Synthetic fixture timings characterize this machine and Bun/SQLite build, not production fleet variance.",
      "The safe-focus benchmark executes the authoritative source path with an injected focus adapter; it never calls cmux or changes focus.",
      "The idle profile measures repeated full JSON snapshots. Phase 0 intentionally has no ETag/304 implementation yet.",
      "The contention fixture holds BEGIN IMMEDIATE in a child process. The query-only catalogue reader must remain readable and complete within the Phase 1 latency gate.",
      "Status, notification, directory, and workspace-state subprocesses are deterministic in-memory adapters, so their real process latency is excluded.",
    ],
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    outputPath,
    contention,
    idleProfile,
    readPathByteIdentical: baseline.databaseWitness.readPathByteIdentical,
    logicalStateUnchanged: baseline.databaseWitness.logicalStateUnchanged,
  }, null, 2)}\n`);
} finally {
  if (previousRoot === undefined) delete process.env.CCS_ROOT;
  else process.env.CCS_ROOT = previousRoot;
  rmSync(temporaryRoot, { recursive: true, force: true });
}
