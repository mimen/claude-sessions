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

  test("promoting an already-connected id through a catalogue self-map cannot form a cycle", () => {
    const ledger = createLivenessLedger();
    // "a" joins as a child of index-primary "b"; the catalogue's ordinary self-map for "a"
    // then promotes it. The old re-rooting left a -> b AND b -> a, and every find() hung.
    ledger.observeIndex([{ sessionId: "b", resumeId: "a" }]);
    ledger.observeCatalogue(new Map([["a", "a"]]));
    expect(ledger.canonicalFor("a")).toBe("a");
    expect(ledger.canonicalFor("b")).toBe("a");
    expect([...ledger.aliasesFor("a")].sort()).toEqual(["a", "b"]);
  });

  test("two distinct catalogue-canonical rows never merge through an index resume edge", () => {
    const ledger = createLivenessLedger();
    ledger.observeCatalogue(new Map([["session-a", "session-a"], ["session-b", "session-b"]]));
    // The index links b to a by resumeId, but the catalogue holds them as separate rows —
    // a boundary it drew on purpose. Merging would collide their projected client ids.
    ledger.observeIndex([{ sessionId: "session-b", resumeId: "session-a" }]);
    expect(ledger.canonicalFor("session-a")).toBe("session-a");
    expect(ledger.canonicalFor("session-b")).toBe("session-b");
    expect(ledger.aliasesFor("session-a")).not.toContain("session-b");
  });

  test("fork siblings sharing a resume parent are never merged", () => {
    const ledger = createLivenessLedger();
    // Both transcripts descend from parent-o; they are two different sessions. Uniting them
    // let a close on one kill the other's workspace.
    ledger.observeIndex([
      { sessionId: "fork-a", resumeId: "parent-o" },
      { sessionId: "fork-b", resumeId: "parent-o" },
      { sessionId: "parent-o", resumeId: "" },
    ]);
    expect(ledger.canonicalFor("fork-a")).not.toBe(ledger.canonicalFor("fork-b"));
    ledger.noteClosed(["fork-a"]);
    expect(ledger.isRecentlyClosed("fork-b")).toBe(false);
  });

  test("a genuine resume merges once the catalogue confirms it, index order notwithstanding", () => {
    const ledger = createLivenessLedger();
    // Both transcripts are indexed (the parent's file survives a resume), so the index edge
    // alone must not decide identity — the catalogue's alias does.
    ledger.observeIndex([
      { sessionId: "session-new", resumeId: "session-old" },
      { sessionId: "session-old", resumeId: "" },
    ]);
    expect(ledger.canonicalFor("session-new")).not.toBe(ledger.canonicalFor("session-old"));
    ledger.observeCatalogue(new Map([["session-new", "session-old"], ["session-old", "session-old"]]));
    expect(ledger.canonicalFor("session-new")).toBe("session-old");
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

  test("hints written before a re-root are still found, retired, and never resurrected", () => {
    let clock = 1_000;
    const ledger = createLivenessLedger({ now: () => clock });
    // Hint lands under the component's current root...
    ledger.observeIndex([{ sessionId: "session-b", resumeId: "resume-b" }]);
    ledger.noteResumed(["session-b"], { workspaceRef: "workspace:7", windowRef: null });
    // ...then the catalogue re-roots the component at a different canonical id.
    ledger.observeCatalogue(new Map([["session-b", "canonical-a"]]));
    expect(ledger.canonicalFor("session-b")).toBe("canonical-a");
    // The hint follows the root instead of being orphaned under the old key.
    expect(ledger.recentResumeTarget(["canonical-a"])?.workspaceRef).toBe("workspace:7");
    expect([...ledger.activeResumeHints().keys()]).toEqual(["canonical-a"]);
    // A close after the re-root retires it for good — no stale copy under the old key can
    // re-canonicalize back into a ghost live row.
    clock += 1;
    ledger.noteClosed(["resume-b"]);
    expect(ledger.recentResumeTarget(["canonical-a"])).toBeNull();
    expect(ledger.activeResumeHints().size).toBe(0);
    expect(ledger.isRecentlyClosed("session-b")).toBe(true);
  });

  test("when a re-root merges opposing hints the newer write wins", () => {
    let clock = 1_000;
    const ledger = createLivenessLedger({ now: () => clock });
    // Two components, one closed then the other resumed later, merged afterwards.
    ledger.noteClosed(["session-x"]);
    clock += 1;
    ledger.noteResumed(["resume-x"], { workspaceRef: "workspace:4", windowRef: null });
    ledger.observeIndex([{ sessionId: "session-x", resumeId: "resume-x" }]);
    expect(ledger.recentResumeTarget(["session-x"])?.workspaceRef).toBe("workspace:4");
    expect(ledger.isRecentlyClosed("session-x")).toBe(false);
  });

  test("a close hint is scoped to the workspace that was closed", () => {
    const ledger = createLivenessLedger();
    ledger.noteClosed(["s"], "workspace-old");
    // The stale binding still pointing at the closed workspace is suppressed...
    expect(ledger.isRecentlyClosed("s", "workspace-old")).toBe(true);
    // ...a binding in a different workspace is a fresh reopen, not suppressed...
    expect(ledger.isRecentlyClosed("s", "workspace-new")).toBe(false);
    // ...and a caller with no binding to compare still gets the suppression.
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

  test("a remembered window that closed is dropped, not inherited forever", () => {
    const ledger = createLivenessLedger();
    ledger.observeActiveWindow("window-a");
    // Degraded pointer, but a readable tree shows window-a is gone: answering with it would
    // filter every workspace against a window nothing can belong to.
    expect(ledger.observeActiveWindow(null, new Set(["window-b"]))).toBeNull();
    // Without live-window evidence the sticky value is still trusted.
    const sticky = createLivenessLedger();
    sticky.observeActiveWindow("window-a");
    expect(sticky.observeActiveWindow(null)).toBe("window-a");
    expect(sticky.observeActiveWindow(null, new Set(["window-a", "window-b"]))).toBe("window-a");
  });
});
