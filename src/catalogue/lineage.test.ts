import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { successionOrder, searchTranscript } from "./lineage.ts";

test("successionOrder: bodies sort by first activity ascending, unindexed last", () => {
  const bodies = [
    { sessionId: "c", firstTs: "2026-07-03T00:00:00Z" },
    { sessionId: "ghost", firstTs: null }, // catalogued but never indexed (e.g. remote body)
    { sessionId: "a", firstTs: "2026-07-01T00:00:00Z" },
    { sessionId: "b", firstTs: "2026-07-02T00:00:00Z" },
  ];
  expect(successionOrder(bodies).map((b) => b.sessionId)).toEqual(["a", "b", "c", "ghost"]);
});

test("successionOrder: ties and equal timestamps stay deterministic (by sessionId)", () => {
  const bodies = [
    { sessionId: "z", firstTs: "2026-07-01T00:00:00Z" },
    { sessionId: "a", firstTs: "2026-07-01T00:00:00Z" },
  ];
  expect(successionOrder(bodies).map((b) => b.sessionId)).toEqual(["a", "z"]);
});

test("searchTranscript: matches prose in user and assistant turns, case-insensitive, capped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-lineage-"));
  const path = join(dir, "t.jsonl");
  try {
    const lines = [
      { type: "user", timestamp: "2026-07-01T10:00:00Z", message: { role: "user", content: "check the Glizzy budget" } },
      {
        type: "assistant",
        timestamp: "2026-07-01T10:01:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "The glizzy budget currently sits at $400." },
            { type: "tool_use", name: "Bash" },
          ],
        },
      },
      { type: "user", timestamp: "2026-07-01T10:02:00Z", message: { role: "user", content: "unrelated turn" } },
      "not json at all", // corrupt line must be skipped, never fatal
      { type: "user", timestamp: "2026-07-01T10:03:00Z", message: { role: "user", content: "GLIZZY again" } },
    ];
    writeFileSync(path, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"));

    const all = (await searchTranscript(path, "glizzy", 10))!;
    expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(all[0]!.snippet).toContain("Glizzy budget");
    expect(all[1]!.snippet).toContain("$400");

    const capped = (await searchTranscript(path, "glizzy", 2))!;
    expect(capped.length).toBe(2);

    expect(await searchTranscript(path, "nomatch-zzz", 10)).toEqual([]);
    expect(await searchTranscript(join(dir, "missing.jsonl"), "x", 10)).toBeNull(); // unreadable ≠ no matches
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchTranscript: long prose is windowed into a bounded snippet around the match", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-lineage-"));
  const path = join(dir, "t.jsonl");
  try {
    const text = `${"a".repeat(500)} needle here ${"b".repeat(500)}`;
    writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: text } }));
    const [m] = (await searchTranscript(path, "needle", 10))!;
    expect(m!.snippet).toContain("needle");
    expect(m!.snippet.length).toBeLessThan(200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchTranscript: snippet stays aligned when Unicode case folding shifts lowercased offsets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-lineage-"));
  const path = join(dir, "t.jsonl");
  try {
    // 'İ' lowercases to 2 code units — an index computed on the lowercased copy would drift.
    const text = `${"İ".repeat(80)} the needle sits here`;
    writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: text } }));
    const [m] = (await searchTranscript(path, "NEEDLE", 10))!;
    expect(m!.snippet).toContain("needle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("searchTranscript: regex metacharacters in the query are literal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-lineage-"));
  const path = join(dir, "t.jsonl");
  try {
    writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: "call foo(bar) now" } }));
    const hit = (await searchTranscript(path, "foo(bar)", 10))!;
    expect(hit.length).toBe(1);
    expect(await searchTranscript(path, "foo(baz)", 10)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
