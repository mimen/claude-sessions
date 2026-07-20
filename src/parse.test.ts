import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "./parse.ts";

function writeJsonl(lines: object[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ccs-parse-"));
  const path = join(dir, "sess.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("extracts metadata, native title, msg count, and skeleton", async () => {
  const { path, cleanup } = writeJsonl([
    { type: "mode", mode: "normal" },
    { type: "user", cwd: "/repo", gitBranch: "main", version: "2.1.156", timestamp: "2026-05-01T10:00:00Z", message: { role: "user", content: "First question" } },
    { type: "assistant", timestamp: "2026-05-01T10:00:05Z", message: { content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "An answer" }, { type: "tool_use", name: "Bash" }] } },
    { type: "user", timestamp: "2026-05-01T10:00:06Z", message: { content: [{ type: "tool_result" }] } },
    { type: "ai-title", aiTitle: "Stale title" },
    { type: "ai-title", aiTitle: "The Real Title" },
    { type: "user", timestamp: "2026-05-01T10:05:00Z", message: { role: "user", content: "Last question" } },
  ]);

  const parsed = await parseSessionFile(path, "sess");
  cleanup();

  expect(parsed.cwd).toBe("/repo");
  expect(parsed.gitBranch).toBe("main");
  expect(parsed.version).toBe("2.1.156");
  expect(parsed.firstTs).toBe("2026-05-01T10:00:00Z");
  expect(parsed.lastTs).toBe("2026-05-01T10:05:00Z");
  expect(parsed.nativeTitle).toBe("The Real Title"); // last ai-title wins
  expect(parsed.msgCount).toBe(4); // 3 user + 1 assistant
  expect(parsed.userTexts[0]).toBe("First question");
  expect(parsed.skeleton).toContain("user: First question");
  expect(parsed.skeleton).toContain("[tool: Bash]");
  expect(parsed.skeleton).not.toContain("hmm"); // thinking omitted
  expect(parsed.isSubagent).toBe(false); // no sidechain messages
});

test("resumeId is the internal sessionId, which can differ from the filename", async () => {
  // Resumed/forked sessions: filename UUID != the internal sessionId claude --resume needs.
  const { path, cleanup } = writeJsonl([
    { type: "user", cwd: "/repo", sessionId: "internal-abc", message: { role: "user", content: "hi" } },
    { type: "assistant", sessionId: "internal-abc", message: { content: [{ type: "text", text: "yo" }] } },
  ]);
  const parsed = await parseSessionFile(path, "filename-xyz");
  cleanup();
  expect(parsed.resumeId).toBe("internal-abc");
  expect(parsed.parentSessionId).toBeNull(); // not a subagent → no parent despite the mismatch
});

test("resumeId falls back to the filename id when no internal sessionId is present", async () => {
  const { path, cleanup } = writeJsonl([
    { type: "user", cwd: "/repo", message: { role: "user", content: "hi" } },
  ]);
  const parsed = await parseSessionFile(path, "filename-only");
  cleanup();
  expect(parsed.resumeId).toBe("filename-only");
});

test("detects a subagent run (all messages sidechain)", async () => {
  const { path, cleanup } = writeJsonl([
    { type: "user", isSidechain: true, cwd: "/repo", message: { role: "user", content: "You are a research sub-agent. Do X." } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "On it" }] } },
  ]);
  const parsed = await parseSessionFile(path, "sub");
  cleanup();
  expect(parsed.isSubagent).toBe(true);
});

test("a mix of normal and sidechain messages is NOT a subagent run", async () => {
  const { path, cleanup } = writeJsonl([
    { type: "user", cwd: "/repo", message: { role: "user", content: "Do a thing" } },
    { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "spawned" }] } },
  ]);
  const parsed = await parseSessionFile(path, "mix");
  cleanup();
  expect(parsed.isSubagent).toBe(false);
});

test("tolerates corrupt lines without throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-parse-"));
  const path = join(dir, "sess.jsonl");
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "user", cwd: "/x", message: { content: "hi" } }),
      "{ this is not valid json",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    ].join("\n"),
  );

  const parsed = await parseSessionFile(path, "sess");
  rmSync(dir, { recursive: true, force: true });

  expect(parsed.cwd).toBe("/x");
  expect(parsed.msgCount).toBe(2);
});

test("sums billed usage from assistant lines into ParsedSession.usage", async () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 700 },
    cache_creation_input_tokens: 1000,
  };
  const { path, cleanup } = writeJsonl([
    { type: "user", cwd: "/repo", message: { role: "user", content: "hi" } },
    {
      type: "assistant",
      requestId: "req1",
      timestamp: "2026-07-01T00:00:00Z",
      message: { id: "msg1", model: "claude-opus-4-8", usage, content: [{ type: "text", text: "a" }] },
    },
    // Streaming duplicate of the same API response — must not double-count.
    {
      type: "assistant",
      requestId: "req1",
      timestamp: "2026-07-01T00:00:01Z",
      message: { id: "msg1", model: "claude-opus-4-8", usage, content: [{ type: "tool_use", name: "Bash" }] },
    },
    {
      type: "assistant",
      message: { id: "msg2", model: "gpt-5.6-sol", content: [{ type: "text", text: "b" }] },
    },
  ]);
  const parsed = await parseSessionFile(path, "cost");
  cleanup();

  expect(parsed.usage.input).toBe(1000);
  expect(parsed.usage.output).toBe(500);
  expect(parsed.usage.cacheRead).toBe(2000);
  expect(parsed.usage.cacheWrite5m).toBe(300);
  expect(parsed.usage.cacheWrite1h).toBe(700);
  // Opus 4.8 $5/$25: in 0.005 + out 0.0125 + read 0.001 + 5m 0.001875 + 1h 0.007 = 0.027375
  expect(parsed.usage.costUSD).toBeCloseTo(0.027375, 9);
  expect(parsed.usage.costByModel["claude-opus-4-8"]).toBeCloseTo(0.027375, 9);
  expect(parsed.usage.models).toEqual(["claude-opus-4-8", "gpt-5.6-sol"]);
});
