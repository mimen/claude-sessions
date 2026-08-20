import { expect, test } from "bun:test";
import type { Bridge } from "../cmux/bridge.ts";
import type { AsyncProcessAdapter } from "../process/async.ts";
import type { ResumeSessionResult } from "../resume/resume-session.ts";
import { createSessionActionCoordinator } from "./session-action-coordinator.ts";
import type { IndexedSessionInput } from "./projection.ts";

const CLOSED_BRIDGE = {
  surfaces: [],
  surfaceToWorkspace: new Map(),
  workspaceIds: () => [],
  surfacesInWorkspace: () => [],
  surfaceInfo: () => null,
  locateSession: () => null,
  isOpen: () => false,
  primarySurface: () => null,
  activeWindowId: null,
  readable: true,
} as unknown as Bridge;

const ROW: IndexedSessionInput = {
  sessionId: "s1",
  resumeId: "s1",
  cwd: "/tmp",
  title: "a session",
  lastTs: "2026-08-20T00:00:00Z",
  models: [],
} as unknown as IndexedSessionInput;

const NEVER_RUNS: AsyncProcessAdapter = {
  async run(): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
    return { ok: true, stdout: "", stderr: "", timedOut: false };
  },
};

function coordinatorReturning(result: ResumeSessionResult) {
  return createSessionActionCoordinator({
    cmuxBin: "cmux",
    readBridge: async () => CLOSED_BRIDGE,
    lookupIndexedSession: () => ({ status: "found", row: ROW }),
    loadLaunchers: () => ({ ok: true, value: [] }),
    resumeSession: async () => ({ status: "ok", result, paintRow: null }),
    processAdapter: NEVER_RUNS,
    paintWorkspace: async () => {},
    defer: () => {},
  });
}

/**
 * A resume that cannot succeed has to say so.
 *
 * Every one of these was reaching the sidebar as "CCS could not complete that action. Refresh the
 * list and try again" — a retryable-sounding sentence for a permanent condition, which is how a
 * session whose model no launcher can replay looked identical to a transient glitch.
 */
test("a resume refusal travels as a code the client can turn into a sentence", async () => {
  for (
    const status of [
      "route-ineligible",
      "unknown-launcher",
      "launcher-env-unresolvable",
      "spawn-failed",
      "cwd-unreadable",
    ] as const
  ) {
    const outcome = await coordinatorReturning(
      { status, reason: "why", name: "x", error: "boom" } as unknown as ResumeSessionResult,
    ).open("s1");

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.refusal).toBe(status);
  }
});

test("a resume that opened but could not clear its lifecycle is named too", async () => {
  const outcome = await coordinatorReturning({
    status: "reactivation-failed",
    workspaceRef: "workspace:9",
  }).open("s1");

  expect(outcome.status).toBe("failed");
  if (outcome.status === "failed") expect(outcome.refusal).toBe("reactivation-failed");
});

/**
 * The free text stays behind. Reasons carry launcher output, filesystem errors and absolute paths,
 * so only the closed vocabulary is allowed out; this is the test that notices if a future status
 * starts smuggling one through.
 */
test("an unclassified failure carries no refusal code at all", async () => {
  const outcome = await coordinatorReturning({ status: "already-open" }).open("s1");

  expect(outcome.status).toBe("failed");
  if (outcome.status === "failed") expect(outcome.refusal).toBeUndefined();
});
