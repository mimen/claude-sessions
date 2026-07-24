import { describe, expect, test } from "bun:test";
import {
  getRow,
  openCatalogue,
  setCreatorKind,
  setLaunchChannel,
  setSessionClass,
  type CatalogueRow,
} from "../catalogue/db.ts";
import type { SessionRow } from "../index/index.ts";
import { buildSessionIntegrityReport } from "./session-integrity.ts";

const ROLLOUT = Date.parse("2026-07-22T00:00:00.000Z");

function session(sessionId: string, firstTs: string, isSubagent = false): SessionRow {
  return {
    sessionId,
    host: "host",
    path: `/tmp/${sessionId}.jsonl`,
    cwd: "/tmp/project",
    projectRoot: "/tmp/project",
    projectName: "project",
    branch: null,
    version: null,
    firstTs,
    lastTs: firstTs,
    msgCount: 1,
    fileSize: 1,
    title: `title ${sessionId}`,
    titleSource: "fallback",
    isSubagent,
    parentSessionId: null,
    resumeId: sessionId,
    costUSD: 0,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: {},
    models: [],
    userTurns: 1,
    tickIntervalSec: 0,
  };
}

describe("session birth integrity report", () => {
  test("reports only post-rollout unmanaged or provenance-missing roots", () => {
    const db = openCatalogue(":memory:");
    const managed = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const missing = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const unclassified = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const missingAgentRef = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const timestamp = "2026-07-22T00:01:00.000Z";

    setSessionClass(db, managed, "work_body", timestamp);
    setCreatorKind(db, managed, "human", timestamp);
    setLaunchChannel(db, managed, "claude_shim", timestamp);
    setSessionClass(db, missing, "auxiliary", timestamp);
    setSessionClass(db, missingAgentRef, "auxiliary", timestamp);
    setCreatorKind(db, missingAgentRef, "agent", timestamp);
    setLaunchChannel(db, missingAgentRef, "ccs_delegate", timestamp);

    const catalogue = new Map<string, CatalogueRow>();
    for (const sessionId of [managed, missing, missingAgentRef]) {
      const row = getRow(db, sessionId);
      if (row) catalogue.set(sessionId, row);
    }
    db.close();

    const report = buildSessionIntegrityReport([
      session(managed, timestamp),
      session(missing, timestamp),
      session(unclassified, timestamp),
      session(missingAgentRef, timestamp),
      session("legacy", "2026-07-21T23:59:00.000Z"),
      session("native-agent", timestamp, true),
    ], catalogue, ROLLOUT);

    expect(report.checked).toBe(4);
    expect(report.counts).toEqual({ unclassified: 1, missing_provenance: 2 });
    expect(report.findings.map((finding) => [finding.sessionId, finding.issue])).toEqual([
      [missing, "missing_provenance"],
      [unclassified, "unclassified"],
      [missingAgentRef, "missing_provenance"],
    ]);
  });
});
