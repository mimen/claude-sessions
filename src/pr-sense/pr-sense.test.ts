import { expect, test } from "bun:test";
import { foldPrFacts } from "./pr-sense.ts";
import type { PrFacts } from "../catalogue/db.ts";

const NOW = "2026-07-08T00:00:00Z";

test("foldPrFacts: stamps PR facts on a session", () => {
  const sensed: PrFacts = {
    prNumber: 123,
    prRepo: "owner/repo",
    prBranch: "feature/test",
    prState: "open",
    prHeadSha: "abc123",
  };
  const result = foldPrFacts(
    {
      sessionId: "s1",
      resumeId: null,
      customTitle: "My Session",
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
      updatedAt: NOW,
      prNumber: null,
      prRepo: null,
      prBranch: null,
      prState: null,
      prHeadSha: null,
    },
    sensed,
  );
  expect(result.prNumber).toBe(123);
  expect(result.prRepo).toBe("owner/repo");
  expect(result.prBranch).toBe("feature/test");
  expect(result.prState).toBe("open");
  expect(result.prHeadSha).toBe("abc123");
  expect(result.customTitle).toBe("My Session"); // preserves existing fields
  expect(result.sessionId).toBe("s1"); // never changes identity
});

test("foldPrFacts: clears PR facts when sensedFacts is null", () => {
  const result = foldPrFacts(
    {
      sessionId: "s2",
      resumeId: null,
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
      updatedAt: NOW,
      prNumber: 456,
      prRepo: "old/repo",
      prBranch: "old-branch",
      prState: "open",
      prHeadSha: "oldsha",
    },
    null,
  );
  expect(result.prNumber).toBeNull();
  expect(result.prRepo).toBeNull();
  expect(result.prBranch).toBeNull();
  expect(result.prState).toBeNull();
  expect(result.prHeadSha).toBeNull();
  expect(result.sessionId).toBe("s2"); // never changes identity
});

test("foldPrFacts: updates PR facts on existing session", () => {
  const sensed: PrFacts = {
    prNumber: 789,
    prRepo: "new/repo",
    prBranch: "new-branch",
    prState: "merged",
    prHeadSha: "newsha",
  };
  const result = foldPrFacts(
    {
      sessionId: "s3",
      resumeId: "resume-id-123",
      customTitle: "Keep This",
      kind: "loop",
      completed: false,
      archived: false,
      parkedTaskId: null,
      event: "glizzy",
      key: null,
      parentSessionId: null,
      skill: "loop-manager",
      project: "ccs",
      system: null,
      gusWork: null,
      notes: "Some notes",
      updatedAt: NOW,
      prNumber: 100,
      prRepo: "old/repo",
      prBranch: "old-branch",
      prState: "open",
      prHeadSha: "oldsha",
    },
    sensed,
  );
  expect(result.prNumber).toBe(789);
  expect(result.prRepo).toBe("new/repo");
  expect(result.prBranch).toBe("new-branch");
  expect(result.prState).toBe("merged");
  expect(result.prHeadSha).toBe("newsha");
  // All other fields preserved
  expect(result.sessionId).toBe("s3");
  expect(result.resumeId).toBe("resume-id-123");
  expect(result.customTitle).toBe("Keep This");
  expect(result.kind).toBe("loop");
  expect(result.event).toBe("glizzy");
  expect(result.skill).toBe("loop-manager");
  expect(result.project).toBe("ccs");
  expect(result.notes).toBe("Some notes");
});

test("foldPrFacts: never overwrites identity key (sessionId)", () => {
  const sensed: PrFacts = {
    prNumber: 999,
    prRepo: "attacker/repo",
    prBranch: "evil",
    prState: "open",
    prHeadSha: "attacksha",
  };
  const result = foldPrFacts(
    {
      sessionId: "IMMUTABLE_ID",
      resumeId: null,
      customTitle: null,
      kind: "session",
      completed: false,
      archived: false,
      parkedTaskId: null,
      event: "original-event",
      key: null,
      parentSessionId: null,
      skill: null,
      project: null,
      system: null,
      gusWork: null,
      notes: null,
      updatedAt: NOW,
      prNumber: null,
      prRepo: null,
      prBranch: null,
      prState: null,
      prHeadSha: null,
    },
    sensed,
  );
  expect(result.sessionId).toBe("IMMUTABLE_ID");
  expect(result.event).toBe("original-event"); // event is the identity key, never changed
  expect(result.prNumber).toBe(999); // but PR facts ARE updated
});
