import { describe, expect, test } from "bun:test";
import { buildBridge } from "../cmux/bridge.ts";
import { createLivenessLedger } from "./liveness-ledger.ts";

function bridgeBinding(sessionId: string): ReturnType<typeof buildBridge> {
  return buildBridge(
    {
      windows: [{
        id: "window-id",
        ref: "window:1",
        workspaces: [{
          id: "workspace-id",
          ref: "workspace:5",
          title: "Live",
          panes: [{
            id: "pane-id",
            ref: "pane:1",
            index: 0,
            surfaces: [{ id: "surface-id", ref: "surface:1", index_in_pane: 0 }],
          }],
        }],
      }],
    },
    { sessions: { [sessionId]: { surfaceId: "surface-id", workspaceId: "workspace-id" } } },
  );
}

describe("liveness ledger identity", () => {
  test("catalogue and index teach one component, catalogue canonical wins either order", () => {
    const first = createLivenessLedger();
    first.observeIndex([{ sessionId: "b", resumeId: "c" }]);
    first.observeCatalogue(new Map([["b", "a"]]));

    const second = createLivenessLedger();
    second.observeCatalogue(new Map([["b", "a"]]));
    second.observeIndex([{ sessionId: "b", resumeId: "c" }]);

    for (const ledger of [first, second]) {
      expect(ledger.canonicalFor("c")).toBe("a");
      expect([...ledger.aliasesFor("a")].sort()).toEqual(["a", "b", "c"]);
    }
  });

  test("without a catalogue verdict the index's row identity beats its resume alias", () => {
    const ledger = createLivenessLedger();
    // "resume-x" sorts before "session-x": the rank, not the alphabet, must decide.
    ledger.observeIndex([{ sessionId: "session-x", resumeId: "resume-x" }]);
    expect(ledger.canonicalFor("resume-x")).toBe("session-x");
  });

  test("canonicalMap covers every observed id", () => {
    const ledger = createLivenessLedger();
    ledger.observeCatalogue(new Map([["alias", "canonical"]]));
    const map = ledger.canonicalMap();
    expect(map.get("alias")).toBe("canonical");
    expect(map.get("canonical")).toBe("canonical");
  });

  test("locate reaches a live binding through any alias", () => {
    const ledger = createLivenessLedger();
    ledger.observeCatalogue(new Map([["live-id", "canonical-id"]]));
    const bridge = bridgeBinding("live-id");
    expect(ledger.locate(bridge, "canonical-id")?.workspaceRef).toBe("workspace:5");
    expect(ledger.locate(bridge, "unknown-id")).toBeNull();
  });
});

describe("liveness ledger hints", () => {
  test("resume hints answer through aliases and expire", () => {
    let clock = 1_000;
    const ledger = createLivenessLedger({ now: () => clock, resumeHintTtlMs: 500 });
    ledger.observeCatalogue(new Map([["alias", "canonical"]]));
    ledger.noteResumed(["alias"], { workspaceRef: "workspace:9", windowRef: null });

    expect(ledger.recentResumeTarget(["canonical"])?.workspaceRef).toBe("workspace:9");
    expect(ledger.activeResumeHints().get("canonical")?.workspaceRef).toBe("workspace:9");

    clock += 501;
    expect(ledger.recentResumeTarget(["canonical"])).toBeNull();
    expect(ledger.activeResumeHints().size).toBe(0);
  });

  test("a close suppresses liveness through aliases, expires, and is lifted by a resume", () => {
    let clock = 1_000;
    const ledger = createLivenessLedger({ now: () => clock, closedHintTtlMs: 500 });
    ledger.observeIndex([{ sessionId: "session-a", resumeId: "resume-a" }]);

    ledger.noteClosed(["resume-a"]);
    expect(ledger.isRecentlyClosed("session-a")).toBe(true);

    clock += 501;
    expect(ledger.isRecentlyClosed("session-a")).toBe(false);

    ledger.noteClosed(["session-a"]);
    ledger.noteResumed(["resume-a"], { workspaceRef: "workspace:2", windowRef: null });
    expect(ledger.isRecentlyClosed("session-a")).toBe(false);
    expect(ledger.recentResumeTarget(["session-a"])?.workspaceRef).toBe("workspace:2");
  });

  test("a close retires a standing resume hint for the same session", () => {
    const ledger = createLivenessLedger();
    ledger.noteResumed(["s"], { workspaceRef: "workspace:3", windowRef: null });
    ledger.noteClosed(["s"]);
    expect(ledger.recentResumeTarget(["s"])).toBeNull();
    expect(ledger.isRecentlyClosed("s")).toBe(true);
  });
});

describe("liveness ledger active window", () => {
  test("a degraded read inherits the last known active window", () => {
    const ledger = createLivenessLedger();
    expect(ledger.observeActiveWindow(null)).toBeNull();
    expect(ledger.observeActiveWindow("window-a")).toBe("window-a");
    expect(ledger.observeActiveWindow(null)).toBe("window-a");
    expect(ledger.observeActiveWindow("window-b")).toBe("window-b");
  });
});
