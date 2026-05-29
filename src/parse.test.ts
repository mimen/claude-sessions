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
