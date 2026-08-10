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
      expect(tail.arc).toBe("");
    });
  });
});

describe("the arc", () => {
  test("covers the middle a long session's head and tail both miss", async () => {
    // The defect this exists for: a 488-message session showed the model turns 1-8 and 429-488,
    // so it named the whole thing after the last thing it touched.
    const lines = Array.from({ length: 300 }, (_, i) => message("user", `turn ${i}`));
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 20);
      const ordinals = [...tail.arc.matchAll(/turn (\d+)/g)].map((m) => Number(m[1]));
      // The middle third is exactly what the skeleton's opening turns and the tail both miss.
      expect(ordinals.some((n) => n > 100 && n < 200)).toBe(true);
      expect(tail.text).not.toMatch(/turn 1\d\d\b/);
    });
  });

  test("is empty when the tail already covers the whole session", async () => {
    // Breadth over a session the model can already see whole would be pure duplication.
    await withTranscript([message("user", "one"), message("assistant", "two")], async (path) => {
      const tail = await readTranscriptTail(path, 50);
      expect(tail.arc).toBe("");
    });
  });

  test("never repeats a prompt the tail already carries", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => message("user", `turn ${i}`));
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 10);
      // Turns 30-39 are in the tail; the arc's budget belongs to everything before them.
      expect(tail.arc).not.toContain("turn 39");
      expect(tail.arc).not.toContain("turn 30");
      expect(tail.arc).toContain("turn 0");
    });
  });

  test("samples evenly rather than taking the first N", async () => {
    // Taking the first N would reproduce the same bug at the opposite end: the opening prompts of
    // a long session are all still its opening topic.
    const lines = Array.from({ length: 600 }, (_, i) => message("user", `turn ${i}`));
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 20);
      const sampled = tail.arc.split("\n");
      expect(sampled.length).toBe(24);
      expect(sampled[0]).toContain("turn 0");
      // Last arc entry sits just under the tail window, not in the first 24 turns.
      expect(sampled.at(-1)).toContain("turn 579");
    });
  });

  test("carries user prompts only, and tags each with its position", async () => {
    const lines = Array.from({ length: 100 }, (_, i) =>
      message(i % 2 === 0 ? "user" : "assistant", `turn ${i}`),
    );
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 10);
      expect(tail.arc).toMatch(/^\[\d+%\] turn 0$/m);
      // Every odd turn is an assistant message, and none of them may appear.
      const ordinals = [...tail.arc.matchAll(/turn (\d+)/g)].map((m) => Number(m[1]));
      expect(ordinals.every((n) => n % 2 === 0)).toBe(true);
      expect(tail.arc).toContain("%] turn 50");
    });
  });

  test("bounds a pasted handoff document to the per-entry budget", async () => {
    // One prompt can be a whole document; the arc is a spine, so it must not become a transcript.
    const lines = [
      message("user", "X".repeat(5_000)),
      ...Array.from({ length: 30 }, (_, i) => message("assistant", `turn ${i}`)),
    ];
    await withTranscript(lines, async (path) => {
      const tail = await readTranscriptTail(path, 10);
      expect(tail.arc.length).toBeLessThan(250);
    });
  });
});
