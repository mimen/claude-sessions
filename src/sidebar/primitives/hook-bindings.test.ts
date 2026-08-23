import { describe, expect, test } from "bun:test";
import { createHookBindingsReader, parseHookStoreRaw } from "./hook-bindings.ts";

const STORE = JSON.stringify({
  sessions: {
    "sess-live": {
      sessionId: "sess-live",
      surfaceId: "SURF-A",
      agentLifecycle: "running",
      pid: 4242,
      transcriptPath: "/tmp/sess-live.jsonl",
    },
    "sess-ghost": {
      sessionId: "sess-ghost",
      surfaceId: "SURF-GONE",
      agentLifecycle: "running",
      pid: 99,
      transcriptPath: "/no/such/file.jsonl",
    },
  },
  activeSessionsBySurface: {
    "SURF-A": { sessionId: "sess-live" },
    "SURF-GONE": { sessionId: "sess-ghost" },
  },
});

describe("parseHookStoreRaw", () => {
  test("rejects torn JSON fail-closed", () => {
    expect(parseHookStoreRaw("{")).toBeNull();
  });

  test("binds surfaces and sessions from both views", () => {
    const parsed = parseHookStoreRaw(STORE);
    expect(parsed?.bindingsBySurface.get("SURF-A")).toBe("sess-live");
    expect(parsed?.sessions.get("sess-ghost")?.pid).toBe(99);
  });
});

describe("createHookBindingsReader", () => {
  test("failed store reads never advance revision", async () => {
    let n = 0;
    const reader = createHookBindingsReader({
      readStore: async () => {
        n += 1;
        return n === 1 ? STORE : null;
      },
      pidAlive: async () => true,
      transcriptState: () => "present",
    });
    const first = await reader.read();
    expect(first.readable).toBe(true);
    expect(first.revision).toBe(1);
    const failed = await reader.read();
    expect(failed.readable).toBe(false);
    expect(failed.revision).toBe(1);
  });

  test("torn JSON is unreadable and does not bump revision", async () => {
    const reader = createHookBindingsReader({
      readStore: async () => "{",
      pidAlive: async () => true,
      transcriptState: () => "present",
    });
    const read = await reader.read();
    expect(read.readable).toBe(false);
    expect(read.revision).toBe(0);
    expect(read.sessions.size).toBe(0);
  });

  test("pidAlive is probed only for running claims", async () => {
    const probed: number[] = [];
    const reader = createHookBindingsReader({
      readStore: async () => STORE,
      pidAlive: async (pid) => {
        probed.push(pid);
        return pid === 4242;
      },
      transcriptState: () => "present",
    });
    const read = await reader.read();
    expect(probed.sort((a, b) => a - b)).toEqual([99, 4242]);
    expect(read.pidLiveness.get("sess-live")).toBe(true);
    expect(read.pidLiveness.get("sess-ghost")).toBe(false);
  });

  test("transcript presence is recorded per session", async () => {
    const reader = createHookBindingsReader({
      readStore: async () => STORE,
      pidAlive: async () => true,
      transcriptState: (_path, sessionId) => (sessionId === "sess-live" ? "present" : "absent"),
    });
    const read = await reader.read();
    expect(read.transcriptPresence.get("sess-live")).toBe("present");
    expect(read.transcriptPresence.get("sess-ghost")).toBe("absent");
  });

  test("identical stores do not bump revision", async () => {
    const reader = createHookBindingsReader({
      readStore: async () => STORE,
      pidAlive: async () => true,
      transcriptState: () => "present",
    });
    const a = await reader.read();
    const b = await reader.read();
    expect(a.revision).toBe(b.revision);
  });
});
