import { expect, test, describe } from "bun:test";
import {
  enrichmentStaleness,
  stalenessLabel,
  MAX_ENRICHMENT_ATTEMPTS,
  STALE_AFTER_MESSAGES,
} from "./staleness.ts";
import type { StoredEnrichment } from "../catalogue/db.ts";

const NOW = new Date("2026-07-24T12:00:00.000Z");

function enrichedAt(at: string, atMessages: number): StoredEnrichment {
  return {
    title: "t",
    summary: "s",
    outstanding: "",
    recommendation: "continue",
    reason: "r",
    junk: false,
    cwdCorrect: true,
    suggestedLocation: null,
    suggestedCwd: null,
    atMessages,
    at,
  };
}

describe("enrichmentStaleness", () => {
  test("a session that has never been enriched is always stale", () => {
    const verdict = enrichmentStaleness({ messageCount: 3, enrichment: null, attempts: 0, now: NOW });
    expect(verdict).toEqual({ stale: true, reason: "never-enriched", messagesSince: 3 });
  });

  test("an idle session never re-enriches, however old its summary is", () => {
    // The cost argument for the whole cadence: a finished session that gains no messages must not
    // cost a model call, no matter how long it sits in the store.
    const ancient = enrichedAt("2020-01-01T00:00:00.000Z", 50);
    const verdict = enrichmentStaleness({ messageCount: 50, enrichment: ancient, attempts: 0, now: NOW });
    expect(verdict.stale).toBe(false);
    expect(verdict.reason).toBe("fresh");
  });

  test(`re-enriches once a session advances ${STALE_AFTER_MESSAGES} messages`, () => {
    const base = enrichedAt("2026-07-24T11:59:00.000Z", 100);
    const justUnder = enrichmentStaleness({
      messageCount: 100 + STALE_AFTER_MESSAGES - 1, enrichment: base, attempts: 0, now: NOW,
    });
    expect(justUnder.stale).toBe(false);

    const atThreshold = enrichmentStaleness({
      messageCount: 100 + STALE_AFTER_MESSAGES, enrichment: base, attempts: 0, now: NOW,
    });
    expect(atThreshold).toEqual({ stale: true, reason: "advanced", messagesSince: STALE_AFTER_MESSAGES });
  });

  test("the age backstop catches a slow session that moved a little, long ago", () => {
    // Below the message threshold, so only elapsed time can make this due.
    const old = enrichedAt("2026-07-24T05:00:00.000Z", 100); // 7h before NOW
    const verdict = enrichmentStaleness({ messageCount: 102, enrichment: old, attempts: 0, now: NOW });
    expect(verdict).toEqual({ stale: true, reason: "aged", messagesSince: 2 });
  });

  test("the age backstop does NOT fire on a session that has not moved at all", () => {
    const old = enrichedAt("2026-07-24T05:00:00.000Z", 100);
    const verdict = enrichmentStaleness({ messageCount: 100, enrichment: old, attempts: 0, now: NOW });
    expect(verdict.stale).toBe(false);
  });

  test("a recently enriched session that moved a little is left alone", () => {
    const recent = enrichedAt("2026-07-24T11:00:00.000Z", 100); // 1h before NOW
    const verdict = enrichmentStaleness({ messageCount: 103, enrichment: recent, attempts: 0, now: NOW });
    expect(verdict).toEqual({ stale: false, reason: "fresh", messagesSince: 3 });
  });

  test("a burnt attempt budget stops a session being retried forever", () => {
    const never = enrichmentStaleness({
      messageCount: 500, enrichment: null, attempts: MAX_ENRICHMENT_ATTEMPTS, now: NOW,
    });
    expect(never).toEqual({ stale: false, reason: "attempts-exhausted", messagesSince: 0 });

    const advanced = enrichmentStaleness({
      messageCount: 200, enrichment: enrichedAt("2026-07-01T00:00:00.000Z", 100),
      attempts: MAX_ENRICHMENT_ATTEMPTS, now: NOW,
    });
    expect(advanced.stale).toBe(false);
    expect(advanced.reason).toBe("attempts-exhausted");
  });

  test("a damaged timestamp is treated as due rather than trusted", () => {
    const damaged = enrichedAt("not-a-date", 100);
    const verdict = enrichmentStaleness({ messageCount: 101, enrichment: damaged, attempts: 0, now: NOW });
    expect(verdict.stale).toBe(true);
    expect(verdict.reason).toBe("aged");
  });

  test("a rewound message count never reports negative progress", () => {
    // Transcripts can shrink (a file is replaced, an index rebuild resolves a duplicate).
    const verdict = enrichmentStaleness({
      messageCount: 5, enrichment: enrichedAt("2026-07-24T11:00:00.000Z", 100), attempts: 0, now: NOW,
    });
    expect(verdict.messagesSince).toBe(0);
    expect(verdict.stale).toBe(false);
  });
});

describe("stalenessLabel", () => {
  test("says nothing when the summary is current", () => {
    expect(stalenessLabel(0)).toBeNull();
  });

  test("is singular for one turn and plural beyond", () => {
    expect(stalenessLabel(1)).toBe("not updated in 1 turn");
    expect(stalenessLabel(42)).toBe("not updated in 42 turns");
  });
});
