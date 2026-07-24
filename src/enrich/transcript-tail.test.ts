import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptTail } from "./transcript-tail.ts";

function withTranscript<T>(lines: unknown[], run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ccs-tail-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return run(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function message(type: "user" | "assistant", text: string, extra: Record<string, unknown> = {}) {
  return { type, message: { role: type, content: [{ type: "text", text }] }, ...extra };
}

describe("readTranscriptTail", () => {
  test("reads the END of a session, not the beginning", async () => {
    // The whole reason this exists next to src/transcript.ts, which reads from the head: catching
    // up means knowing where a session landed.
    const lines = Array.from({ length: 100 }, (_, i) => message("user", `turn ${i}`));
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 5);
      expect(tail.text).toContain("turn 99");
      expect(tail.text).not.toContain("turn 0\n");
      expect(tail.truncated).toBe(true);
    });
  });

  test("keeps a short session whole and unmarked", async () => {
    await withTranscript([message("user", "hello"), message("assistant", "hi")], async (path) => {
      const tail = await readTranscriptTail(path, 50);
      expect(tail.text).toBe("user: hello\n\nassistant: hi");
      expect(tail.truncated).toBe(false);
    });
  });

  test("skips subagent sidechains", async () => {
    // A delegated run is a different body of work; including it makes the parent read as if it
    // did work it actually handed off.
    const lines = [
      message("user", "parent asks"),
      message("assistant", "delegating", { isSidechain: true }),
      message("user", "sidechain noise", { isSidechain: true }),
      message("assistant", "parent answers"),
    ];
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 50);
      expect(tail.text).toContain("parent asks");
      expect(tail.text).toContain("parent answers");
      expect(tail.text).not.toContain("sidechain noise");
    });
  });

  test("keeps tool names but drops tool results", async () => {
    const lines = [
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", content: "a very long directory listing" }] } },
      message("assistant", "done"),
    ];
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 50);
      expect(tail.text).toContain("→ Bash");
      expect(tail.text).not.toContain("directory listing");
    });
  });

  test("trims from the front when over the character budget", async () => {
    const lines = [message("user", "A".repeat(400)), message("assistant", "THE-END")];
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 50, 100);
      expect(tail.text.length).toBe(100);
      expect(tail.text).toContain("THE-END");
      expect(tail.truncated).toBe(true);
    });
  });

  test("survives corrupt lines and non-message records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccs-tail-corrupt-"));
    const path = join(dir, "session.jsonl");
    writeFileSync(path, [
      "{not json at all",
      JSON.stringify({ type: "summary", summary: "ignored" }),
      "",
      JSON.stringify(message("assistant", "still here")),
    ].join("\n"));
    try {
      const tail = await readTranscriptTail(path, 50);
      expect(tail.text).toBe("assistant: still here");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty transcript yields empty text rather than throwing", async () => {
    await withTranscript([], async (path) => {
      const tail = await readTranscriptTail(path, 50);
      expect(tail.text).toBe("");
      expect(tail.truncated).toBe(false);
    });
  });
});
