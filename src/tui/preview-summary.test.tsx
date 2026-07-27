import { expect, test } from "bun:test";
import { createElement } from "react";
import { render } from "ink-testing-library";
import type { SessionRow } from "../index/index.ts";
import { Preview, type PreviewSummary } from "./Preview.tsx";

function row(): SessionRow {
  return {
    sessionId: "s1",
    host: "test",
    path: "/tmp/s1.jsonl",
    cwd: "/tmp",
    projectRoot: "/tmp",
    projectName: "test",
    branch: null,
    version: null,
    firstTs: null,
    lastTs: null,
    msgCount: 142,
    fileSize: 0,
    title: "a session",
    titleSource: "fallback",
    isSubagent: false,
    parentSessionId: null,
    resumeId: "s1",
    costUSD: 0,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: {},
    models: [],
    userTurns: 0,
    tickIntervalSec: 0,
  };
}

function frameFor(summary: PreviewSummary | null, detailsOpen = false): string {
  const { lastFrame, unmount } = render(
    createElement(Preview, {
      row: row(),
      skeleton: "",
      parentTitle: null,
      descendantCount: 0,
      selfCost: 0,
      totalCost: 0,
      providerCost: { claude: 0, gpt: 0, other: 0 },
      summary,
      height: 40,
      width: 120,
      detailsOpen,
      peekLines: null,
      peekScroll: 0,
    }),
  );
  const frame = lastFrame() ?? "";
  unmount();
  return frame;
}

const base: PreviewSummary = {
  summary: "Ported the sidebar to shadcn",
  reason: null,
  recommendation: null,
  outstanding: null,
  atMessages: 100,
  messagesSince: 42,
};

test("the compact header states how far the transcript has outrun the summary", () => {
  const frame = frameFor(base);
  expect(frame).toContain("42 msgs behind");
  expect(frame).toContain("Ported the sidebar to shadcn");
});

test("a summary level with the transcript reads as current", () => {
  expect(frameFor({ ...base, messagesSince: 0 })).toContain("current");
});

// The distinction that matters: an un-stamped summary must not masquerade as a fresh one.
test("an un-stamped summary reports unknown age rather than current", () => {
  const frame = frameFor({ ...base, atMessages: null, messagesSince: null });
  expect(frame).toContain("age unknown");
  expect(frame).not.toContain("current");
});

test("one message behind is singular", () => {
  expect(frameFor({ ...base, messagesSince: 1 })).toContain("1 msg behind");
});

test("a session with no summary shows no staleness marker", () => {
  const frame = frameFor(null);
  expect(frame).not.toContain("behind");
  expect(frame).not.toContain("age unknown");
});

test("the details dossier shows every enrichment field", () => {
  const frame = frameFor({
    ...base,
    reason: "the port is complete",
    recommendation: "open the PR",
    outstanding: "screenshots still needed",
  }, true);
  expect(frame).toContain("42 msgs behind");
  expect(frame).toContain("Ported the sidebar to shadcn");
  expect(frame).toContain("open the PR");
  expect(frame).toContain("screenshots still needed");
  expect(frame).toContain("the port is complete");
});
