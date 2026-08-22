import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  auditCoverage,
  auditTranscriptRows,
  CLAUDE_STORE,
  RECENT_WINDOW_MS,
  REINDEX_GRACE_MS,
  transcriptState,
  type IndexedSessionInput,
} from "./sidebar-ground-truth-lib.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-ground-truth-"));
  roots.push(root);
  return root;
}

function indexedRow(overrides: Partial<IndexedSessionInput> = {}): IndexedSessionInput {
  return {
    sessionId: "aaaaaaaa-0000-4000-8000-000000000001",
    resumeId: "aaaaaaaa-0000-4000-8000-000000000001",
    title: "row",
    cwd: null,
    lastTs: null,
    models: [],
    costByModel: {},
    messageCount: null,
    transcriptPath: null,
    indexedBytes: null,
    ...overrides,
  };
}

describe("auditTranscriptRows", () => {
  test("flags an index that claims more bytes than an append-only file can hold", () => {
    const root = scratch();
    const path = join(root, "s1.jsonl");
    writeFileSync(path, "{}\n");
    const findings = auditTranscriptRows([
      indexedRow({ sessionId: "s1", transcriptPath: path, indexedBytes: 10_000 }),
    ]);
    expect(findings.some((f) => f.severity === "error" && f.detail.includes("append-only"))).toBe(true);
  });

  test("accepts a file larger than its indexed bytes — the index is allowed to trail", () => {
    const root = scratch();
    const path = join(root, "s2.jsonl");
    writeFileSync(path, "{}\n{}\n");
    const findings = auditTranscriptRows([
      indexedRow({ sessionId: "s2", transcriptPath: path, indexedBytes: 2 }),
    ]);
    expect(findings.every((f) => f.severity !== "error")).toBe(true);
  });

  test("flags msg_count exceeding the real line count", () => {
    const root = scratch();
    const path = join(root, "s3.jsonl");
    writeFileSync(path, "a\nb\nc\n");
    const findings = auditTranscriptRows([
      indexedRow({ sessionId: "s3", transcriptPath: path, messageCount: 99 }),
    ]);
    expect(findings.some((f) => f.detail.includes("msg_count 99"))).toBe(true);
  });

  test("tolerates a missing file without inventing an error", () => {
    const findings = auditTranscriptRows([
      indexedRow({ sessionId: "gone", transcriptPath: "/nonexistent/gone.jsonl", indexedBytes: 5 }),
    ]);
    expect(findings.every((f) => f.severity === "info")).toBe(true);
  });
});

describe("auditCoverage", () => {
  const nowMs = Date.now();

  test("recent-but-within-grace absences stay informational", () => {
    const recentFiles = new Map([
      ["fresh-one", { path: "/x/fresh-one.jsonl", mtimeMs: nowMs - 60_000 }],
    ]);
    const findings = auditCoverage({ indexedIds: new Set(), recentFiles, nowMs });
    expect(findings.some((f) => f.severity === "error")).toBe(false);
    expect(findings.some((f) => f.detail.includes("1/1"))).toBe(true);
  });

  test("absences beyond the reindex grace become errors naming the file", () => {
    const recentFiles = new Map([
      [
        "stale-one",
        { path: "/x/stale-one.jsonl", mtimeMs: nowMs - REINDEX_GRACE_MS - 60_000 },
      ],
    ]);
    const findings = auditCoverage({ indexedIds: new Set(), recentFiles, nowMs });
    expect(findings.some((f) => f.severity === "error" && f.detail.includes("stale-one"))).toBe(true);
  });

  test("indexed sessions never appear as coverage gaps", () => {
    const recentFiles = new Map([
      ["known", { path: "/x/known.jsonl", mtimeMs: nowMs - RECENT_WINDOW_MS / 2 }],
    ]);
    const findings = auditCoverage({
      indexedIds: new Set(["known"]),
      recentFiles,
      nowMs,
    });
    expect(findings.every((f) => f.detail.startsWith("0/"))).toBe(true);
  });
});

describe("transcriptState", () => {
  test("renamed .orphaned-* transcripts count as renamed, not absent", () => {
    const id = `orphan-test-${Date.now()}`;
    const dir = join(CLAUDE_STORE, "-ccs-ground-truth-fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.orphaned-1234567890-abcd.jsonl`), "{}\n");
    try {
      expect(transcriptState(null, id)).toBe("renamed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a recorded path that exists wins over the store search", () => {
    const root = scratch();
    const path = join(root, "real.jsonl");
    writeFileSync(path, "{}\n");
    expect(transcriptState(path, "whatever-id")).toBe("present");
  });
});
