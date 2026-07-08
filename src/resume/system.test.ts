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
  project: null,
  system: null,
  gusWork: null,
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
  expect(actions[0]).toEqual({ action: "resume", sessionId: "s1", resumeId: "r1", cwd: "/tmp/a" });
  expect(actions[1]).toEqual({ action: "reanchor", sessionId: "s2" });
  expect(actions[2]).toEqual({ action: "skip-retired", sessionId: "s3" });
  expect(actions[3]).toEqual({ action: "reanchor", sessionId: "s4" });
  expect(actions[4]).toEqual({ action: "skip-retired", sessionId: "s5" });
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
