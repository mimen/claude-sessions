import { test, expect } from "bun:test";
import { planResumeSession, resumeSessionEntry } from "./resume-session.ts";
import { openIndex } from "../index/schema.ts";
import { openCatalogue, setResumeId } from "../catalogue/db.ts";
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
function stubBridge(openIds: string[], readable = true): Bridge {
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
    readable,
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

test("resume FAILS CLOSED when liveness is unreadable — never spawns (ADR-0054)", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  const NOW = "2026-07-11T00:00:00Z";
  try {
    idx.query(
      `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
         fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
       VALUES ('s1', 'h', '/store/s1.jsonl', '/tmp', '/tmp', 'p', 's1', $now, $now, 1, 0, 0, 0, 's1')`,
    ).run({ $now: NOW });
    setResumeId(cat, "s1", "s1", NOW);
    // an UNREADABLE bridge (readable:false) must abort — even in dry-run, and even though the id
    // isn't in the (empty) open set. Fail-open here would re-spawn a possibly-running session.
    const res = resumeSessionEntry(idx, cat, "s1", { dryRun: true, bridge: stubBridge([], false) });
    expect(res.status).toBe("liveness-unreadable");
  } finally {
    idx.close();
    cat.close();
  }
});
