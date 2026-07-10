import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMessage, pendingMessages, drain } from "./inbox.ts";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "ccs-inbox-"));
}

describe("writeMessage", () => {
  test("writes a message atomically and returns its path under inbox/", () => {
    const dir = fresh();
    try {
      const p = writeMessage(dir, "control", "do the thing", "20260709T000000Z");
      expect(p).toContain("/inbox/");
      expect(pendingMessages(dir).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("disambiguates same-stamp same-sender messages (no overwrite)", () => {
    const dir = fresh();
    try {
      writeMessage(dir, "scout", "first", "20260709T000000Z");
      writeMessage(dir, "scout", "second", "20260709T000000Z");
      expect(pendingMessages(dir).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pendingMessages", () => {
  test("empty / missing inbox returns []", () => {
    const dir = fresh();
    try {
      expect(pendingMessages(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ordered chronologically by stamped filename", () => {
    const dir = fresh();
    try {
      writeMessage(dir, "a", "newer", "20260709T120000Z");
      writeMessage(dir, "b", "older", "20260709T010000Z");
      const names = pendingMessages(dir).map((p) => p.split("/").pop()!);
      expect(names[0]).toContain("20260709T010000Z"); // older first
      expect(names[1]).toContain("20260709T120000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drain (move-on-drain, ADR-0033)", () => {
  test("returns pending bodies AND moves them to processed/ in one step", () => {
    const dir = fresh();
    try {
      writeMessage(dir, "control", "task one", "20260709T000001Z");
      writeMessage(dir, "scout", "slack ping", "20260709T000002Z");
      const msgs = drain(dir);
      expect(msgs.map((m) => m.body.trim())).toEqual(["task one", "slack ping"]);
      expect(msgs.map((m) => m.sender)).toEqual(["control", "scout"]);
      // inbox is now empty; both moved to processed/
      expect(pendingMessages(dir)).toEqual([]);
      expect(readdirSync(join(dir, "inbox", "processed")).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("idempotent: a second drain returns nothing (already moved)", () => {
    const dir = fresh();
    try {
      writeMessage(dir, "control", "once", "20260709T000000Z");
      expect(drain(dir).length).toBe(1);
      expect(drain(dir).length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("processed/ is retained as the audit trail (not deleted)", () => {
    const dir = fresh();
    try {
      writeMessage(dir, "a", "x", "20260709T000000Z");
      drain(dir);
      writeMessage(dir, "b", "y", "20260709T000001Z");
      drain(dir);
      expect(readdirSync(join(dir, "inbox", "processed")).length).toBe(2); // both kept
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a processed-name collision does not overwrite an earlier archived message", () => {
    const dir = fresh();
    try {
      // two rounds where a same-named message could collide in processed/
      writeMessage(dir, "a", "first", "20260709T000000Z");
      drain(dir);
      writeMessage(dir, "a", "second", "20260709T000000Z");
      drain(dir);
      expect(readdirSync(join(dir, "inbox", "processed")).length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
