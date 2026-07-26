import { expect, test, describe } from "bun:test";
import { disagreement } from "./triage.ts";
import type { CatalogueRow, StoredEnrichment } from "../catalogue/db.ts";
import type { SessionRow } from "../index/index.ts";
import type { Recommendation } from "../catalogue/enrichment-schema.ts";

/**
 * `disagreement` is the whole rule: which sessions belong in the queue, and what applying the
 * verdict would set. Testing it directly rather than through `triageQueue` keeps the rule
 * separable from index/catalogue plumbing, which is the reason it is a pure function.
 */

const NOW = "2026-07-26T06:00:00.000Z";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "a3f12c9d-0000-4000-8000-000000000000",
    title: "indexed title",
    cwd: "/Users/mimen/Programming/Repos/t3code",
    msgCount: 120,
    lastTs: NOW,
    isSubagent: false,
    ...overrides,
  } as SessionRow;
}

function enrichment(overrides: Partial<StoredEnrichment> = {}): StoredEnrichment {
  return {
    title: "T3 static-seam refactor",
    state: "Refactor is done and green, sitting uncommitted in worktree-phase0-seam-baseline.",
    history: "",
    next: "Launch the build and try the refactor",
    remaining: "",
    recommendation: "complete",
    reason: "",
    junk: false,
    cwdCorrect: null,
    suggestedLocation: null,
    suggestedCwd: null,
    atMessages: 120,
    at: NOW,
    legacyShape: false,
    ...overrides,
  };
}

function row(overrides: Partial<CatalogueRow> = {}): CatalogueRow {
  return {
    completed: false,
    archived: false,
    parkedTaskId: null,
    enrichment: enrichment(),
    ...overrides,
  } as CatalogueRow;
}

describe("disagreement", () => {
  test("an unenriched session is not in the queue", () => {
    expect(disagreement(session(), row({ enrichment: null }))).toBeNull();
    expect(disagreement(session(), null)).toBeNull();
  });

  test("continue implies nothing — idle is the correct filing for live work", () => {
    const item = disagreement(
      session(), row({ enrichment: enrichment({ recommendation: "continue" }) }),
    );
    expect(item).toBeNull();
  });

  test("complete on an idle session is the 162-row gap this exists for", () => {
    const item = disagreement(session(), row());
    expect(item?.lifecycle).toBe("idle");
    expect(item?.target).toBe("completed");
    expect(item?.title).toBe("T3 static-seam refactor");
  });

  test("archive and handoff both imply archived", () => {
    for (const recommendation of ["archive", "handoff"] as const) {
      const item = disagreement(
        session(),
        row({ enrichment: enrichment({ recommendation, reason: "Superseded." }) }),
      );
      expect(item?.target).toBe("archived");
    }
  });

  test("a session already filed the way it reads is not surfaced", () => {
    const item = disagreement(session(), row({ completed: true }));
    expect(item).toBeNull();
  });

  test("an archived session recommended complete is left alone", () => {
    // Both mean "done", a human already made the call, and surfacing it would be the queue
    // arguing with its reader over a distinction that changes nothing.
    const item = disagreement(session(), row({ archived: true }));
    expect(item).toBeNull();
  });

  test("a completed session recommended archive is left alone", () => {
    const item = disagreement(
      session(),
      row({ completed: true, enrichment: enrichment({ recommendation: "archive", reason: "Dead end." }) }),
    );
    expect(item).toBeNull();
  });

  test("parked is a deliberate decision, not an oversight", () => {
    // Someone set this aside on purpose with a task to come back to. Asking them to re-decide is
    // the queue second-guessing a choice that was already made.
    const item = disagreement(session(), row({ parkedTaskId: "task-1" }));
    expect(item).toBeNull();
  });

  test("junk is flagged so the queue can group it", () => {
    const item = disagreement(
      session({ msgCount: 12 }),
      row({ enrichment: enrichment({ junk: true, recommendation: "archive", reason: "Probe." }) }),
    );
    expect(item?.junk).toBe(true);
    expect(item?.target).toBe("archived");
    expect(item?.messages).toBe(12);
  });

  test("the enriched title wins, and the indexed one is the fallback", () => {
    expect(disagreement(session(), row())?.title).toBe("T3 static-seam refactor");
    const untitled = disagreement(
      session(), row({ enrichment: enrichment({ title: "" }) }),
    );
    expect(untitled?.title).toBe("indexed title");
  });

  test("every recommendation is handled — a new enum value cannot silently vanish", () => {
    const recommendations: Recommendation[] = ["continue", "complete", "archive", "handoff"];
    for (const recommendation of recommendations) {
      const needsReason = recommendation === "archive" || recommendation === "handoff";
      const item = disagreement(
        session(),
        row({ enrichment: enrichment({ recommendation, reason: needsReason ? "why" : "" }) }),
      );
      // continue is the only one that is legitimately absent from the queue.
      if (recommendation === "continue") expect(item).toBeNull();
      else expect(item).not.toBeNull();
    }
  });
});
