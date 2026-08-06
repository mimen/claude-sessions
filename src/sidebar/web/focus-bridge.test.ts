import { describe, expect, test } from "bun:test";
import {
  focusWorkspaceRow,
  requestCmuxFocus,
  type CmuxWebkitBridge,
  type FocusBridgeOutcome,
  type FocusBridgeRequest,
} from "./focus-bridge.ts";

type Reply = Parameters<typeof JSON.stringify>[0];

interface StubBridge {
  readonly bridge: CmuxWebkitBridge;
  readonly sent: FocusBridgeRequest[];
}

/** A host that answers with one fixed reply, recording every message it was sent. */
function bridgeReplying(reply: Reply): StubBridge {
  const sent: FocusBridgeRequest[] = [];
  return {
    sent,
    bridge: {
      messageHandlers: {
        cmuxSidebarFocusWorkspace: {
          postMessage: async (message): Promise<Reply> => {
            sent.push(message);
            return reply;
          },
        },
      },
    },
  };
}

describe("requestCmuxFocus", () => {
  test("reports no bridge when the host installs no handler", async () => {
    expect(await requestCmuxFocus("w1", { bridge: null })).toBe("no-bridge");
    expect(await requestCmuxFocus("w1", { bridge: {} })).toBe("no-bridge");
    expect(await requestCmuxFocus("w1", { bridge: { messageHandlers: {} } })).toBe("no-bridge");
  });

  test("sends the versioned request and accepts the three known statuses", async () => {
    const focused = bridgeReplying({ v: 1, status: "focused" });
    expect(await requestCmuxFocus("w1", { bridge: focused.bridge })).toBe("focused");
    expect(focused.sent).toEqual([{ v: 1, workspaceId: "w1" }]);

    expect(await requestCmuxFocus("w1", {
      bridge: bridgeReplying({ v: 1, status: "not-found" }).bridge,
    })).toBe("not-found");
    expect(await requestCmuxFocus("w1", {
      bridge: bridgeReplying({ v: 1, status: "unavailable" }).bridge,
    })).toBe("unavailable");
  });

  test("refuses every reply that is not exactly the contract", async () => {
    const replies: readonly Reply[] = [
      { status: "focused" },
      { v: 2, status: "focused" },
      { v: "1", status: "focused" },
      { v: 1 },
      { v: 1, status: "ok" },
      { v: 1, status: "FOCUSED" },
      { v: 1, status: null },
      [{ v: 1, status: "focused" }],
      "focused",
      42,
      null,
    ];
    for (const reply of replies) {
      expect(await requestCmuxFocus("w1", { bridge: bridgeReplying(reply).bridge }))
        .toBe("malformed-reply");
    }
  });

  test("refuses an otherwise-valid envelope that carries any extra key", async () => {
    // Each of these is a host that has grown a field this page was never taught to weigh. Reading
    // `focused` out of them and dropping the rest would answer a question that was not asked.
    const replies: readonly Reply[] = [
      { v: 1, status: "focused", capabilities: ["focus", "close"] },
      { v: 1, status: "focused", error: "focused the wrong window" },
      { v: 1, status: "focused", partial: true },
      { v: 1, status: "not-found", suggestion: "w2" },
      { v: 1, status: "unavailable", retryAfterMs: 500 },
      { v: 1, status: "focused", extra: null },
      { v: 1, status: "focused", v2: 2 },
    ];
    for (const reply of replies) {
      expect(await requestCmuxFocus("w1", { bridge: bridgeReplying(reply).bridge }))
        .toBe("malformed-reply");
    }
  });

  test("refuses an envelope that renames or drops either required key", async () => {
    const replies: readonly Reply[] = [
      { v: 1, state: "focused" },
      { version: 1, status: "focused" },
      { v: 1, Status: "focused" },
      {},
    ];
    for (const reply of replies) {
      expect(await requestCmuxFocus("w1", { bridge: bridgeReplying(reply).bridge }))
        .toBe("malformed-reply");
    }
  });

  test("does not accept an inherited status or a status-shaped array", async () => {
    // A prototype-supplied field is not an own key, so this envelope has one own key and fails the
    // count rather than borrowing `status` from up the chain.
    const inherited: Record<string, number> = Object.create({ status: "focused" }) as Record<
      string,
      number
    >;
    inherited["v"] = 1;
    expect(await requestCmuxFocus("w1", { bridge: bridgeReplying(inherited).bridge }))
      .toBe("malformed-reply");

    // A null-prototype object with exactly the right own keys is still a valid reply: the rule is
    // about which own keys are present, not about which constructor made the object.
    const bare: Record<string, string | number> = Object.create(null) as Record<
      string,
      string | number
    >;
    bare["v"] = 1;
    bare["status"] = "focused";
    expect(await requestCmuxFocus("w1", { bridge: bridgeReplying(bare).bridge })).toBe("focused");

    // An array is typeof "object", so it is refused explicitly rather than by key count.
    expect(await requestCmuxFocus("w1", { bridge: bridgeReplying(["focused", 1]).bridge }))
      .toBe("malformed-reply");
  });

  test("treats a rejected or throwing postMessage as a bridge failure", async () => {
    const rejecting: CmuxWebkitBridge = {
      messageHandlers: {
        cmuxSidebarFocusWorkspace: {
          postMessage: async (): Promise<never> => { throw new Error("host detached"); },
        },
      },
    };
    expect(await requestCmuxFocus("w1", { bridge: rejecting })).toBe("rejected");

    const throwing: CmuxWebkitBridge = {
      messageHandlers: {
        cmuxSidebarFocusWorkspace: {
          postMessage: (): Promise<never> => { throw new Error("handler is gone"); },
        },
      },
    };
    expect(await requestCmuxFocus("w1", { bridge: throwing })).toBe("rejected");
  });

  test("gives up on a silent host at the deadline", async () => {
    const silent: CmuxWebkitBridge = {
      messageHandlers: {
        cmuxSidebarFocusWorkspace: {
          postMessage: () => new Promise(() => {}),
        },
      },
    };
    expect(await requestCmuxFocus("w1", { bridge: silent, timeoutMs: 1 })).toBe("timeout");
  });

  test("still accepts a reply that arrives before a long deadline", async () => {
    const slow: CmuxWebkitBridge = {
      messageHandlers: {
        cmuxSidebarFocusWorkspace: {
          postMessage: async (): Promise<Reply> => {
            await Bun.sleep(5);
            return { v: 1, status: "focused" };
          },
        },
      },
    };
    expect(await requestCmuxFocus("w1", { bridge: slow, timeoutMs: 1_000 })).toBe("focused");
  });
});

describe("focusWorkspaceRow", () => {
  test("performs no HTTP action when the host confirms the focus", async () => {
    let calls = 0;
    const result = await focusWorkspaceRow(
      { workspaceId: "w1" },
      async () => { calls += 1; return "http"; },
      { bridge: bridgeReplying({ v: 1, status: "focused" }).bridge },
    );

    expect(result.outcome).toBe("focused");
    expect(result.fallback).toEqual({ performed: false });
    expect(calls).toBe(0);
  });

  test("falls through exactly once for every outcome that is not a focus", async () => {
    const cases: ReadonlyArray<readonly [CmuxWebkitBridge | null, FocusBridgeOutcome]> = [
      [null, "no-bridge"],
      [bridgeReplying({ v: 1, status: "not-found" }).bridge, "not-found"],
      [bridgeReplying({ v: 1, status: "unavailable" }).bridge, "unavailable"],
      [bridgeReplying({ v: 9, status: "focused" }).bridge, "malformed-reply"],
      [{
        messageHandlers: {
          cmuxSidebarFocusWorkspace: {
            postMessage: async (): Promise<never> => { throw new Error("no"); },
          },
        },
      }, "rejected"],
      [{
        messageHandlers: {
          cmuxSidebarFocusWorkspace: { postMessage: () => new Promise<never>(() => {}) },
        },
      }, "timeout"],
    ];

    for (const [bridge, expected] of cases) {
      let calls = 0;
      const result = await focusWorkspaceRow(
        { workspaceId: "w1" },
        async () => { calls += 1; return "http"; },
        { bridge, timeoutMs: 1 },
      );
      expect(result.outcome).toBe(expected);
      expect(result.fallback).toEqual({ performed: true, value: "http" });
      expect(calls).toBe(1);
    }
  });

  test("never messages the host for a row with no workspace", async () => {
    const stub = bridgeReplying({ v: 1, status: "focused" });
    let calls = 0;
    const result = await focusWorkspaceRow(
      { workspaceId: null },
      async () => { calls += 1; return "http"; },
      { bridge: stub.bridge },
    );

    expect(result.outcome).toBe("no-bridge");
    expect(result.fallback).toEqual({ performed: true, value: "http" });
    expect(stub.sent).toEqual([]);
    expect(calls).toBe(1);
  });
});
