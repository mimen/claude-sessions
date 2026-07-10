import { expect, test } from "bun:test";
import type { CatalogueRow } from "../catalogue/db.ts";
import { planSystemResume, type SystemMember, type ResumeAction } from "./system.ts";

/** Helper to build a minimal CatalogueRow with the required fields. */
const cat = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  sessionId: "s",
  resumeId: "r",
  customTitle: null,
  kind: "session",
  completed: false,
  archived: false,
  parkedTaskId: null,
  event: null,
  key: null,
  parentSessionId: null,
  skill: null,
  role: null,
  resumeCommand: null,
  project: null,
  system: null,
  gusWork: null,
  epicId: null, phase: null,
  notes: null,
  updatedAt: null,
  prNumber: null,
  prRepo: null,
  prBranch: null,
  prState: null,
  prHeadSha: null,
  ...over,
});

test("planSystemResume: idle + not live → resume", () => {
  const members: SystemMember[] = [
    { sessionId: "s1", resumeId: "r1", cwd: "/tmp/a", catalogueRow: cat({ sessionId: "s1", resumeId: "r1" }) },
  ];
  const liveByCwd = new Set<string>();
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "resume",
    sessionId: "s1",
    resumeId: "r1",
    cwd: "/tmp/a",
  });
});

test("planSystemResume: one PR with 2 sessions → freshest resumes, older superseded (no dup pane)", () => {
  // Both sessions belong to PR heroku/dashboard#12120; only ONE should resume.
  const members: SystemMember[] = [
    {
      sessionId: "older", resumeId: "ro", cwd: "/wt/a",
      catalogueRow: cat({ sessionId: "older", resumeId: "ro", prRepo: "heroku/dashboard", prNumber: 12120, updatedAt: "2026-07-01T00:00:00Z" }),
    },
    {
      sessionId: "fresher", resumeId: "rf", cwd: "/wt/a",
      catalogueRow: cat({ sessionId: "fresher", resumeId: "rf", prRepo: "heroku/dashboard", prNumber: 12120, updatedAt: "2026-07-08T00:00:00Z" }),
    },
  ];
  const actions = planSystemResume(members, new Set<string>());
  const resumed = actions.filter((a) => a.action === "resume");
  const superseded = actions.filter((a) => a.action === "superseded");
  expect(resumed).toHaveLength(1);
  expect(resumed[0]?.sessionId).toBe("fresher"); // freshest by updatedAt wins
  expect(superseded).toHaveLength(1);
  expect(superseded[0]?.sessionId).toBe("older");
});

test("planSystemResume: if one session of a PR is already live, the other is superseded not resumed", () => {
  const members: SystemMember[] = [
    {
      sessionId: "live", resumeId: "rl", cwd: "/wt/live",
      catalogueRow: cat({ sessionId: "live", resumeId: "rl", prRepo: "heroku/dashboard", prNumber: 12121, updatedAt: "2026-07-02T00:00:00Z" }),
    },
    {
      sessionId: "dead", resumeId: "rd", cwd: "/wt/dead",
      catalogueRow: cat({ sessionId: "dead", resumeId: "rd", prRepo: "heroku/dashboard", prNumber: 12121, updatedAt: "2026-07-08T00:00:00Z" }),
    },
  ];
  const actions = planSystemResume(members, new Set<string>(["/wt/live"]));
  const liveAction = actions.find((a) => a.sessionId === "live");
  const deadAction = actions.find((a) => a.sessionId === "dead");
  expect(liveAction?.action).toBe("reanchor");
  expect(deadAction?.action).toBe("superseded");
});

test("planSystemResume: parked + not live → resume", () => {
  const members: SystemMember[] = [
    {
      sessionId: "s1",
      resumeId: "r1",
      cwd: "/tmp/a",
      catalogueRow: cat({ sessionId: "s1", resumeId: "r1", parkedTaskId: "task-123" }),
    },
  ];
  const liveByCwd = new Set<string>();
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "resume",
    sessionId: "s1",
    resumeId: "r1",
    cwd: "/tmp/a",
  });
});

test("planSystemResume: completed → skip-retired", () => {
  const members: SystemMember[] = [
    {
      sessionId: "s1",
      resumeId: "r1",
      cwd: "/tmp/a",
      catalogueRow: cat({ sessionId: "s1", resumeId: "r1", completed: true }),
    },
  ];
  const liveByCwd = new Set<string>();
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "skip-retired",
    sessionId: "s1",
  });
});

test("planSystemResume: archived → skip-retired", () => {
  const members: SystemMember[] = [
    {
      sessionId: "s1",
      resumeId: "r1",
      cwd: "/tmp/a",
      catalogueRow: cat({ sessionId: "s1", resumeId: "r1", archived: true }),
    },
  ];
  const liveByCwd = new Set<string>();
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "skip-retired",
    sessionId: "s1",
  });
});

test("planSystemResume: idle + live → reanchor", () => {
  const members: SystemMember[] = [
    { sessionId: "s1", resumeId: "r1", cwd: "/tmp/a", catalogueRow: cat({ sessionId: "s1", resumeId: "r1" }) },
  ];
  const liveByCwd = new Set(["/tmp/a"]);
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "reanchor",
    sessionId: "s1",
  });
});

test("planSystemResume: parked + live → reanchor", () => {
  const members: SystemMember[] = [
    {
      sessionId: "s1",
      resumeId: "r1",
      cwd: "/tmp/a",
      catalogueRow: cat({ sessionId: "s1", resumeId: "r1", parkedTaskId: "task-123" }),
    },
  ];
  const liveByCwd = new Set(["/tmp/a"]);
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "reanchor",
    sessionId: "s1",
  });
});

test("planSystemResume: idempotent — all live → all reanchor", () => {
  const members: SystemMember[] = [
    { sessionId: "s1", resumeId: "r1", cwd: "/tmp/a", catalogueRow: cat({ sessionId: "s1", resumeId: "r1" }) },
    { sessionId: "s2", resumeId: "r2", cwd: "/tmp/b", catalogueRow: cat({ sessionId: "s2", resumeId: "r2" }) },
    {
      sessionId: "s3",
      resumeId: "r3",
      cwd: "/tmp/c",
      catalogueRow: cat({ sessionId: "s3", resumeId: "r3", parkedTaskId: "task-456" }),
    },
  ];
  const liveByCwd = new Set(["/tmp/a", "/tmp/b", "/tmp/c"]);
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(3);
  expect(actions.every((a) => a.action === "reanchor")).toBe(true);
});

test("planSystemResume: mixed states", () => {
  const members: SystemMember[] = [
    { sessionId: "s1", resumeId: "r1", cwd: "/tmp/a", catalogueRow: cat({ sessionId: "s1", resumeId: "r1" }) }, // idle, not live
    {
      sessionId: "s2",
      resumeId: "r2",
      cwd: "/tmp/b",
      catalogueRow: cat({ sessionId: "s2", resumeId: "r2", parkedTaskId: "task-123" }),
    }, // parked, live
    {
      sessionId: "s3",
      resumeId: "r3",
      cwd: "/tmp/c",
      catalogueRow: cat({ sessionId: "s3", resumeId: "r3", completed: true }),
    }, // completed
    { sessionId: "s4", resumeId: "r4", cwd: "/tmp/d", catalogueRow: cat({ sessionId: "s4", resumeId: "r4" }) }, // idle, live
    {
      sessionId: "s5",
      resumeId: "r5",
      cwd: "/tmp/e",
      catalogueRow: cat({ sessionId: "s5", resumeId: "r5", archived: true }),
    }, // archived
  ];
  const liveByCwd = new Set(["/tmp/b", "/tmp/d"]);
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(5);
  // Assert by session (order is not meaningful — live-claims are emitted first, then
  // the rest freshest-first; each of these 5 is a distinct unit so nothing is superseded).
  const bySid = Object.fromEntries(actions.map((a) => [a.sessionId, a]));
  expect(bySid.s1).toEqual({ action: "resume", sessionId: "s1", resumeId: "r1", cwd: "/tmp/a" });
  expect(bySid.s2).toEqual({ action: "reanchor", sessionId: "s2" });
  expect(bySid.s3).toEqual({ action: "skip-retired", sessionId: "s3" });
  expect(bySid.s4).toEqual({ action: "reanchor", sessionId: "s4" });
  expect(bySid.s5).toEqual({ action: "skip-retired", sessionId: "s5" });
});

test("planSystemResume: no catalogue row → treats as idle + not live → resume", () => {
  const members: SystemMember[] = [
    { sessionId: "s1", resumeId: "r1", cwd: "/tmp/a", catalogueRow: null },
  ];
  const liveByCwd = new Set<string>();
  const actions = planSystemResume(members, liveByCwd);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual({
    action: "resume",
    sessionId: "s1",
    resumeId: "r1",
    cwd: "/tmp/a",
  });
});
