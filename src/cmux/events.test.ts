/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  type CmuxChangeScope,
  type CmuxEventStreamIo,
  type CmuxEventStreamProcess,
  scopesForFrame,
  subscribeToCmuxEvents,
} from "./events.ts";

function event(category: string, name: string): string {
  return JSON.stringify({ type: "event", category, name, seq: 1 });
}

/** A stream that yields the given lines and then ends, as a real one does when cmux exits. */
function finiteStream(lines: readonly string[]): CmuxEventStreamProcess {
  return {
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    kill: () => {},
  };
}

function collectingIo(
  runs: readonly (readonly string[])[],
): { io: CmuxEventStreamIo; args: string[][] } {
  const args: string[][] = [];
  let run = 0;
  return {
    args,
    io: {
      spawn(_cmuxBin, spawnArgs) {
        args.push([...spawnArgs]);
        const lines = runs[Math.min(run, runs.length - 1)] ?? [];
        run += 1;
        return finiteStream(lines);
      },
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("scopesForFrame", () => {
  test("a workspace change invalidates both where it sits and what it contains", () => {
    expect([...(scopesForFrame(JSON.parse(event("workspace", "workspace.selected"))) ?? [])])
      .toEqual(["liveness", "workspaceState"]);
  });

  test("cmux's own status publication invalidates the status pill", () => {
    expect([...(scopesForFrame(JSON.parse(event("sidebar", "sidebar.metadata.updated"))) ?? [])])
      .toEqual(["status"]);
  });

  test("window and notification frames each invalidate their own source", () => {
    expect([...(scopesForFrame(JSON.parse(event("window", "window.focused"))) ?? [])])
      .toEqual(["liveness"]);
    expect([...(scopesForFrame(JSON.parse(event("notification", "notification.cleared"))) ?? [])])
      .toEqual(["notifications"]);
  });

  test("a session starting rebinds a surface, so it invalidates liveness", () => {
    const scopes = scopesForFrame(JSON.parse(event("agent", "agent.hook.SessionStart")));
    expect([...(scopes ?? [])]).toEqual(["liveness", "status"]);
  });

  test("per-tool agent hooks are ignored, being the bulk of the stream and moving nothing", () => {
    // A sampled minute was a third `agent.hook.PreToolUse`. Acting on them would invalidate every
    // cache several times a second for changes the sidebar does not show.
    expect(scopesForFrame(JSON.parse(event("agent", "agent.hook.PreToolUse")))).toBeNull();
    expect(scopesForFrame(JSON.parse(event("agent", "agent.hook.PostToolUse")))).toBeNull();
  });

  test("feed frames are ignored as duplicates of the agent frames they mirror", () => {
    expect(scopesForFrame(JSON.parse(event("feed", "feed.item.received")))).toBeNull();
  });

  test("non-event frames and unknown categories change nothing", () => {
    expect(scopesForFrame(JSON.parse('{"type":"heartbeat"}'))).toBeNull();
    expect(scopesForFrame(JSON.parse(event("something-new", "something.new")))).toBeNull();
    expect(scopesForFrame(null)).toBeNull();
    expect(scopesForFrame("not a frame")).toBeNull();
  });
});

describe("subscribeToCmuxEvents", () => {
  test("reports what each frame invalidated, and nothing for frames that invalidate nothing", async () => {
    const seen: CmuxChangeScope[][] = [];
    const { io } = collectingIo([[
      event("workspace", "workspace.selected"),
      event("agent", "agent.hook.PreToolUse"),
      event("notification", "notification.cleared"),
    ]]);

    const subscription = subscribeToCmuxEvents({
      io,
      onChange: (scopes) => seen.push([...scopes]),
      logger: { warn: () => {}, info: () => {} },
      retryDelaysMs: [10_000],
      sleep: () => new Promise(() => {}),
    });
    await settle();
    subscription.stop();

    expect(seen).toEqual([["liveness", "workspaceState"], ["notifications"]]);
  });

  test("lets cmux handle socket drops itself rather than respawning per drop", async () => {
    const { io, args } = collectingIo([[]]);
    const subscription = subscribeToCmuxEvents({
      io,
      onChange: () => {},
      logger: { warn: () => {}, info: () => {} },
      retryDelaysMs: [10_000],
      sleep: () => new Promise(() => {}),
    });
    await settle();
    subscription.stop();

    expect(args[0]).toEqual(["events", "--reconnect"]);
  });

  test("a resume that dropped events revalidates everything rather than guessing what was missed", async () => {
    const seen: CmuxChangeScope[][] = [];
    const { io } = collectingIo([[
      JSON.stringify({ type: "ack", resume: { gap: true, after_seq: 10 } }),
    ]]);

    const subscription = subscribeToCmuxEvents({
      io,
      onChange: (scopes) => seen.push([...scopes].sort()),
      logger: { warn: () => {}, info: () => {} },
      retryDelaysMs: [10_000],
      sleep: () => new Promise(() => {}),
    });
    await settle();
    subscription.stop();

    expect(seen).toEqual([["liveness", "notifications", "status", "workspaceState"]]);
  });

  test("an ack with no gap is not a change", async () => {
    const seen: CmuxChangeScope[][] = [];
    const { io } = collectingIo([[
      JSON.stringify({ type: "ack", resume: { gap: false, after_seq: null } }),
    ]]);

    const subscription = subscribeToCmuxEvents({
      io,
      onChange: (scopes) => seen.push([...scopes]),
      logger: { warn: () => {}, info: () => {} },
      retryDelaysMs: [10_000],
      sleep: () => new Promise(() => {}),
    });
    await settle();
    subscription.stop();

    expect(seen).toEqual([]);
  });

  test("a malformed line does not end an otherwise healthy stream", async () => {
    const seen: CmuxChangeScope[][] = [];
    const { io } = collectingIo([[
      "{ this is not json",
      event("window", "window.focused"),
    ]]);

    const subscription = subscribeToCmuxEvents({
      io,
      onChange: (scopes) => seen.push([...scopes]),
      logger: { warn: () => {}, info: () => {} },
      retryDelaysMs: [10_000],
      sleep: () => new Promise(() => {}),
    });
    await settle();
    subscription.stop();

    expect(seen).toEqual([["liveness"]]);
  });

  test("a cmux without an event stream is reported once, not once per attempt", async () => {
    const warnings: string[] = [];
    const { io } = collectingIo([[], [], []]);
    let sleeps = 0;

    const subscription = subscribeToCmuxEvents({
      io,
      onChange: () => {},
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      retryDelaysMs: [0],
      sleep: async (ms) => {
        sleeps += 1;
        if (sleeps > 3) await new Promise(() => {});
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    await settle();
    await settle();
    subscription.stop();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("falling back to timed reads");
  });

  test("stopping ends the supervision loop rather than respawning forever", async () => {
    const { io, args } = collectingIo([[], [], []]);
    const subscription = subscribeToCmuxEvents({
      io,
      onChange: () => {},
      logger: { warn: () => {}, info: () => {} },
      retryDelaysMs: [0],
      // A real timer rather than an immediate promise: respawning through resolved microtasks
      // alone never yields to the timer phase, so the loop would starve this test's own settle.
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    await settle();
    subscription.stop();
    const spawnsAtStop = args.length;
    await settle();
    await settle();

    expect(args.length).toBe(spawnsAtStop);
  });
});
