import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "./transcript.ts";

function writeJsonl(lines: object[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ccs-tx-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("renders user/assistant prose and stubs tool calls with input hints", async () => {
  const { path, cleanup } = writeJsonl([
    { type: "mode", mode: "normal" },
    { type: "user", message: { role: "user", content: "fix the build" } },
    { type: "assistant", message: { content: [
      { type: "thinking", text: "secret" },
      { type: "text", text: "On it." },
      { type: "tool_use", name: "Bash", input: { command: "bun test" } },
    ] } },
    { type: "user", message: { content: [{ type: "tool_result" }] } },
  ]);
  const { lines, truncated } = await readTranscript(path);
  cleanup();

  const texts = lines.map((l) => l.text);
  expect(texts).toContain("fix the build");
  expect(texts).toContain("On it.");
  expect(texts).toContain("→ Bash bun test");
  expect(texts).toContain("← tool result");
  expect(texts).not.toContain("secret"); // thinking omitted
  expect(truncated).toBe(false);
});

test("respects the message cap and flags truncation", async () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    type: "user",
    message: { role: "user", content: `msg ${i}` },
  }));
  const { path, cleanup } = writeJsonl(many);
  const { lines, truncated } = await readTranscript(path, 3);
  cleanup();

  expect(truncated).toBe(true);
  expect(lines.filter((l) => l.kind === "user")).toHaveLength(3);
});

test("tolerates corrupt lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-tx-"));
  const path = join(dir, "s.jsonl");
  writeFileSync(path, [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    "{ broken",
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
  ].join("\n"));
  const { lines } = await readTranscript(path);
  rmSync(dir, { recursive: true, force: true });
  expect(lines.map((l) => l.text)).toEqual(expect.arrayContaining(["hi", "ok"]));
});
