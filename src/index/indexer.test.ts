import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { reindexStore, sessionById } from "./index.ts";
import { openIndex } from "./schema.ts";
import { exactMessageCount } from "../sidebar/tail-count.ts";
import type { StoredSessionFile } from "../store.ts";

function transcript(path: string, cwd: string): void {
  writeFileSync(path, `${JSON.stringify({ type: "user", cwd, message: { content: "hello" } })}\n`);
}

function file(path: string, sessionId: string, sizeBytes: number, mtimeMs: number): StoredSessionFile {
  return { path, sessionId, sizeBytes, mtimeMs };
}

test("reindex canonicalizes duplicate paths independent of scan order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-duplicate-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  transcript(a, "/canonical-a");
  transcript(b, "/shadow-b");
  const db = openIndex(":memory:");
  try {
    const files = [file(b, "same", 10, 20), file(a, "same", 10, 20)];
    const first = await reindexStore(db, files, "host");
    expect(first.duplicates).toBe(1);
    expect(sessionById(db, "same")?.path).toBe(a);
    expect(sessionById(db, "same")?.shadowPaths).toEqual([b]);

    const second = await reindexStore(db, [...files].reverse(), "host");
    expect(second.parsed).toBe(0);
    expect(second.skipped).toBe(1);
    expect(sessionById(db, "same")?.path).toBe(a);
    expect(sessionById(db, "same")?.shadowPaths).toEqual([b]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reindex switches canonical transcript and clears stale diagnostics without catalogue writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-duplicate-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  transcript(a, "/first");
  transcript(b, "/second");
  const index = openIndex(join(dir, "index.db"));
  const catalogue = openCatalogue(join(dir, "catalogue.db"));
  try {
    catalogue.query("INSERT INTO catalogue (session_id, custom_title) VALUES ('catalogued', 'unchanged')").run();
    const first = await reindexStore(index, [file(a, "same", 20, 10), file(b, "same", 10, 30)], "host");
    expect(first.duplicates).toBe(1);
    expect(sessionById(index, "same")?.path).toBe(a);

    const switched = await reindexStore(index, [file(a, "same", 20, 10), file(b, "same", 30, 1)], "host");
    expect(switched.parsed).toBe(1);
    expect(sessionById(index, "same")?.path).toBe(b);
    expect(sessionById(index, "same")?.shadowPaths).toEqual([a]);

    const cleared = await reindexStore(index, [file(b, "same", 30, 1)], "host");
    expect(cleared.duplicates).toBe(0);
    expect(cleared.skipped).toBe(1);
    expect(sessionById(index, "same")?.shadowPaths).toEqual([]);
    expect(catalogue.query("SELECT custom_title FROM catalogue WHERE session_id = 'catalogued'").get()).toEqual({ custom_title: "unchanged" });
    expect(catalogue.query("SELECT session_id FROM catalogue WHERE session_id = 'same'").get()).toBeNull();
  } finally {
    index.close();
    catalogue.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The store scan stats every file before any is parsed, so a live session can append between the
// two. The stored count must describe the stored size, or the sidebar's tail count adds the
// appended messages a second time.
test("reindex counts only the bytes it records as file_size", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-grown-"));
  const path = join(dir, "grown.jsonl");
  transcript(path, "/grown");
  const scanned = statSync(path);
  appendFileSync(path, `${JSON.stringify({ type: "assistant", message: { content: "late" } })}\n`);
  const db = openIndex(":memory:");
  try {
    await reindexStore(db, [file(path, "grown", scanned.size, scanned.mtimeMs)], "host");
    const row = sessionById(db, "grown");
    expect(row?.fileSize).toBe(scanned.size);
    expect(row?.msgCount).toBe(1);
    expect(await exactMessageCount({
      transcriptPath: path,
      messageCount: row?.msgCount,
      indexedBytes: row?.fileSize,
    })).toBe(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
