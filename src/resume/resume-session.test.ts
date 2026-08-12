import { test, expect } from "bun:test";
import { chooseLauncher, planResumeSession, resumeSessionEntry, resumeSessionEntryAsync } from "./resume-session.ts";
import { openIndex } from "../index/schema.ts";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getRow } from "../catalogue/db-queries.ts";
import { setCluster, setCompleted, setResumeId, setRole, setSaved } from "../catalogue/db-mutations.ts";
import type { AsyncProcessAdapter } from "../process/async.ts";
import type { SessionRow } from "../index/index.ts";
import type { Bridge } from "../cmux/bridge.ts";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "s-1", host: "h", path: "/p", cwd: "/tmp", projectRoot: "/tmp",
    projectName: "p", branch: null, version: null, firstTs: null, lastTs: null,
    msgCount: 0, fileSize: 0, title: "t", titleSource: "fallback",
    isSubagent: false, parentSessionId: null, resumeId: "resume-1", costUSD: 0,
    tokInput: 0, tokOutput: 0, tokCacheRead: 0, tokCacheWrite: 0, costByModel: {},
    userTurns: 0, tickIntervalSec: 0, models: [], lastModel: "", ...over,
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
    activeWindowId: null,
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

test("one-shot prompt overrides a loop's recurring resume command", () => {
  const plan = planResumeSession(
    stubBridge([]),
    row({ resumeId: "resume-1", cwd: "/tmp" }),
    {
      resumeCommand: "/loop 15m /pr-watch-control",
      prompt: "Continue the session starter",
    },
  );
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  expect(plan.command.argv).toEqual([
    "claude",
    "--resume",
    "resume-1",
    "Continue the session starter",
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

test("ADR-0094: a declared permission mode precedes the positional resume prompt", () => {
  const plan = planResumeSession(
    stubBridge([]),
    row({ resumeId: "resume-1", cwd: "/tmp" }),
    { resumeCommand: "/loop /event-watch", permissionMode: "bypassPermissions" },
  );
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  // Order is load-bearing: the resume command is POSITIONAL, so a flag after it would be
  // swallowed into the prompt text instead of parsed.
  expect(plan.command.argv).toEqual([
    "claude",
    "--resume",
    "resume-1",
    "--permission-mode",
    "bypassPermissions",
    "/loop /event-watch",
  ]);
});

test("ADR-0094: a worker with a declared mode and no resume command resumes with just the flag", () => {
  const plan = planResumeSession(stubBridge([]), row({ resumeId: "resume-1", cwd: "/tmp" }), {
    resumeCommand: null,
    permissionMode: "bypassPermissions",
  });
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  expect(plan.command.argv).toEqual(["claude", "--resume", "resume-1", "--permission-mode", "bypassPermissions"]);
});

test("no declared permission mode leaves argv byte-identical to pre-ADR-0094 resume", () => {
  const plan = planResumeSession(stubBridge([]), row({ resumeId: "resume-1", cwd: "/tmp" }), {
    resumeCommand: null,
    permissionMode: null,
  });
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  expect(plan.command.argv).not.toContain("--permission-mode");
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

test("resume plan never injects a role birth model", () => {
  // A role policy may later change, but replay is history-routed and has no --model override.
  const plan = planResumeSession(stubBridge([]), row({ models: ["gpt-5.6-sol[1m]"] }), {
    binary: "claude-gpt",
    resumeCommand: null,
  });
  expect(plan.action).toBe("resume");
  if (plan.action !== "resume") throw new Error("unreachable");
  expect(plan.command.argv).toEqual(["claude-gpt", "--resume", "resume-1"]);
  expect(plan.command.argv).not.toContain("--model");
});

test("launcher selection reports unknown and ineligible routes without falling back", () => {
  const launchers = [
    { name: "claude", binary: "claude", serves: ["claude-*"] as const, env: {}, clears: [] },
    { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"] as const, env: {}, clears: [] },
  ];

  expect(chooseLauncher(launchers, ["gpt-5.6"], { via: "missing" })).toEqual({
    ok: false,
    status: "unknown-launcher",
    name: "missing",
  });
  const ineligible = chooseLauncher(launchers, ["gpt-5.6"], { via: "claude" });
  expect(ineligible.ok).toBe(false);
  if (!ineligible.ok) expect(ineligible.status).toBe("route-ineligible");
  expect(chooseLauncher(launchers, ["gpt-5.6"], {})).toMatchObject({
    ok: true,
    launcher: { name: "claude-gpt" },
  });
});

test("resumed status carries workspaceRef so callers can act on the workspace pre-hook (pin/paint)", () => {
  // Contract test: `pinIfRequested` for a JUST-spawned session used to look up the workspace by
  // sessionId, which misses because cmux hasn't bound surface→session yet (the child claude's
  // SessionStart hook hasn't fired). The result now carries the workspaceRef so the caller pins
  // by ref directly, mirroring the eager-paint pattern in executeResumePlan.
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  const NOW = "2026-07-11T00:00:00Z";
  try {
    idx.query(
      `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
         fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
       VALUES ('s2', 'h', '/store/s2.jsonl', '/tmp', '/tmp', 'p', 's2', $now, $now, 1, 0, 0, 0, 's2')`,
    ).run({ $now: NOW });
    setResumeId(cat, "s2", "s2", NOW);
    const res = resumeSessionEntry(idx, cat, "s2", { dryRun: true, bridge: stubBridge([]) });
    expect(res.status).toBe("resumed");
    if (res.status !== "resumed") throw new Error("unreachable");
    // dry-run doesn't spawn → no ref, but the field is present in the union
    expect(res.workspaceRef).toBeNull();
  } finally {
    idx.close();
    cat.close();
  }
});

test("ADR-0094: resume policy FAILS OPEN — a deleted config package never strands history", () => {
  // Deliberate asymmetry with birth: a fresh session refuses to launch under a broken policy, but
  // an existing transcript must stay reachable even after its cluster package is gone or renamed.
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  const NOW = "2026-07-11T00:00:00Z";
  try {
    idx.query(
      `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
         fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
       VALUES ('s3', 'h', '/store/s3.jsonl', '/tmp', '/tmp', 'p', 's3', $now, $now, 1, 0, 0, 0, 's3')`,
    ).run({ $now: NOW });
    setResumeId(cat, "s3", "s3", NOW);
    setCluster(cat, "s3", "cluster-that-was-deleted", NOW);
    setRole(cat, "s3", "role-that-was-deleted", NOW);
    const res = resumeSessionEntry(idx, cat, "s3", { dryRun: true, bridge: stubBridge([]) });
    expect(res.status).toBe("resumed");
  } finally {
    idx.close();
    cat.close();
  }
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

test("completed sessions remain terminal until explicitly reactivated", () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  const NOW = "2026-08-11T00:00:00Z";
  try {
    idx.query(
      `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
         fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
       VALUES ('done', 'h', '/store/done.jsonl', '/tmp', '/tmp', 'p', 'done', $now, $now, 1, 0, 0, 0, 'done')`,
    ).run({ $now: NOW });
    setResumeId(cat, "done", "done", NOW);
    setCompleted(cat, "done", true, NOW);

    expect(resumeSessionEntry(idx, cat, "done", { dryRun: true, bridge: stubBridge([]) })).toEqual({
      status: "completed",
    });
  } finally {
    idx.close();
    cat.close();
  }
});

test("successfully resuming a saved session reactivates it", async () => {
  const idx = openIndex(":memory:");
  const cat = openCatalogue(":memory:");
  const NOW = "2026-08-11T00:00:00Z";
  const processAdapter: AsyncProcessAdapter = {
    async run(): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
      return { ok: true, stdout: "OK workspace:91", stderr: "", timedOut: false };
    },
  };
  try {
    idx.query(
      `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
         fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
       VALUES ('saved', 'h', '/store/saved.jsonl', '/tmp', '/tmp', 'p', 'saved', $now, $now, 1, 0, 0, 0, 'saved')`,
    ).run({ $now: NOW });
    setResumeId(cat, "saved", "saved", NOW);
    setSaved(cat, "saved", true, NOW);

    const result = await resumeSessionEntryAsync(
      idx,
      cat,
      "saved",
      {
        bridge: stubBridge([]),
        reactivateSaved(sessionId): boolean {
          setSaved(cat, sessionId, false, NOW);
          return true;
        },
      },
      processAdapter,
    );

    expect(result.status).toBe("resumed");
    expect(getRow(cat, "saved")?.saved).toBeFalse();
  } finally {
    idx.close();
    cat.close();
  }
});
