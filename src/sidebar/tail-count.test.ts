import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exactMessageCount } from "./tail-count.ts";

function transcript(lines: ReadonlyArray<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "ccs-tail-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const USER = { type: "user", message: { content: "hi" } };
const ASSISTANT = { type: "assistant", message: { content: "hello" } };

test("a transcript the index has fully parsed reports the stored count", async () => {
  const path = transcript([USER, ASSISTANT]);
  const size = statSync(path).size;
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 2, indexedBytes: size }))
    .toBe(2);
});

test("messages appended since the index parsed are counted", async () => {
  const path = transcript([USER, ASSISTANT]);
  const indexedBytes = statSync(path).size;
  appendFileSync(path, [USER, ASSISTANT, USER].map((l) => JSON.stringify(l)).join("\n") + "\n");
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 2, indexedBytes }))
    .toBe(5);
});

// The index counts only user and assistant lines, so anything else in the tail must not count
// either -- a number built on a different rule cannot be compared against the stored one.
test("only user and assistant lines count, matching the index's own rule", async () => {
  const path = transcript([USER]);
  const indexedBytes = statSync(path).size;
  appendFileSync(path, [
    { type: "summary", summary: "compacted" },
    { type: "ai-title", aiTitle: "A name" },
    { type: "system", content: "hook fired" },
    ASSISTANT,
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 1, indexedBytes }))
    .toBe(2);
});

// The last line of a live transcript is routinely half-written. Counting a torn line would
// overcount by one on exactly the sessions being watched most closely.
test("a half-written final line is not a message", async () => {
  const path = transcript([USER]);
  const indexedBytes = statSync(path).size;
  appendFileSync(path, `${JSON.stringify(ASSISTANT)}\n{"type":"assistant","mess`);
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 1, indexedBytes }))
    .toBe(2);
});

test("a truncated or rotated transcript yields no count rather than a wrong one", async () => {
  const path = transcript([USER, ASSISTANT]);
  const indexedBytes = statSync(path).size + 5_000;
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 2, indexedBytes }))
    .toBeNull();
});

test("a transcript that has vanished yields no count", async () => {
  const path = transcript([USER]);
  const indexedBytes = statSync(path).size;
  rmSync(path);
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 1, indexedBytes }))
    .toBeNull();
});

// An index predating file_size (or path, or msg_count) lands here. Null keeps today's behaviour:
// the caller falls back to comparing mtime against the enrichment timestamp.
test("a column the index does not carry yields no count", async () => {
  const path = transcript([USER]);
  const size = statSync(path).size;
  expect(await exactMessageCount({ transcriptPath: path, messageCount: 1, indexedBytes: null }))
    .toBeNull();
  expect(await exactMessageCount({ transcriptPath: path, messageCount: null, indexedBytes: size }))
    .toBeNull();
  expect(await exactMessageCount({ transcriptPath: null, messageCount: 1, indexedBytes: size }))
    .toBeNull();
  expect(await exactMessageCount({})).toBeNull();
});

// The whole point: a session that has typed since the last refresh must not read as current.
test("a session that moved since the index refreshed does not read as unchanged", async () => {
  const path = transcript([USER, ASSISTANT]);
  const indexedBytes = statSync(path).size;
  appendFileSync(path, `${JSON.stringify(USER)}\n`);
  const stored = 2;
  const exact = await exactMessageCount({ transcriptPath: path, messageCount: stored, indexedBytes });
  expect(exact).toBe(3);
  expect(exact).toBeGreaterThan(stored);
});
