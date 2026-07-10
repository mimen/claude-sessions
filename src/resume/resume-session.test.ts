import { test, expect } from "bun:test";
import { planResumeSession } from "./resume-session.ts";
import type { SessionRow } from "../index/index.ts";
import type { Bridge } from "../cmux/bridge.ts";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "s-1", host: "h", path: "/p", cwd: "/tmp", projectRoot: "/tmp",
    projectName: "p", branch: null, version: null, firstTs: null, lastTs: null,
    msgCount: 0, fileSize: 0, title: "t", titleSource: "fallback",
    isSubagent: false, parentSessionId: null, resumeId: "resume-1", costUSD: 0,
    tokInput: 0, tokOutput: 0, tokCacheRead: 0, tokCacheWrite: 0, costByModel: {},
    userTurns: 0, tickIntervalSec: 0, ...over,
  };
}

/** A stub bridge that reports a fixed set of open session ids. */
function stubBridge(openIds: string[]): Bridge {
  const open = new Set(openIds);
  return {
    surfaces: [],
    surfaceToWorkspace: new Map(),
    workspaceIds: () => [],
    surfacesInWorkspace: () => [],
    surfaceInfo: () => null,
    locateSession: () => null,
    isOpen: (id: string) => open.has(id),
    primarySurface: () => null,
  };
}

test("already-open session is skipped (idempotent, no duplicate pane)", () => {
  const plan = planResumeSession(stubBridge(["resume-1"]), row({ resumeId: "resume-1" }), null);
  expect(plan.action).toBe("skip");
});

test("closed loop session resumes RUNNING (resume_command replayed as trailing prompt)", () => {
  const plan = planResumeSession(
    stubBridge([]),
    row({ resumeId: "resume-1", cwd: "/tmp" }),
    { resumeCommand: "/loop 15m /pr-watch-control" },
  );
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  expect(plan.command.argv).toEqual([
    "claude",
    "--resume",
    "resume-1",
    "/loop 15m /pr-watch-control",
  ]);
});

test("closed worker resumes bare (no resume_command)", () => {
  const plan = planResumeSession(stubBridge([]), row({ resumeId: "resume-1", cwd: "/tmp" }), {
    resumeCommand: null,
  });
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  expect(plan.command.argv).toEqual(["claude", "--resume", "resume-1"]);
});

test("liveness keys on resumeId (the id claude --resume uses), not the filename sessionId", () => {
  // open set holds the resume id; a session whose resumeId is open must be seen as open
  const plan = planResumeSession(
    stubBridge(["resume-1"]),
    row({ sessionId: "filename-x", resumeId: "resume-1" }),
    null,
  );
  expect(plan.action).toBe("skip");
});
