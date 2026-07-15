import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db.ts";
import {
  drainForIdentity,
  historyForIdentity,
  pendingCountByIdentity,
  pendingForIdentity,
  purgeDrainedBefore,
  sendMessage,
} from "./inbox-db.ts";
import { migrateFileInboxesToDb } from "./inbox-migrate.ts";

const NOW = "2026-07-14T12:00:00Z";
const LATER = "2026-07-14T12:05:00Z";

describe("inbox CRUD", () => {
  test("sendMessage inserts a pending row, pendingForIdentity returns it", () => {
    const db = openCatalogue(":memory:");
    const id = sendMessage(db, "pr-watch:pr-agent:owner/repo#1", "hello", "orchestrator", NOW);
    expect(id).toBeGreaterThan(0);
    const rows = pendingForIdentity(db, "pr-watch:pr-agent:owner/repo#1");
    expect(rows.length).toBe(1);
    expect(rows[0]!.message).toBe("hello");
    expect(rows[0]!.fromRole).toBe("orchestrator");
    expect(rows[0]!.status).toBe("pending");
  });

  test("drainForIdentity atomically flips status; a second drain returns nothing", () => {
    const db = openCatalogue(":memory:");
    sendMessage(db, "k1", "a", "sender", NOW);
    sendMessage(db, "k1", "b", "sender", NOW);
    const drained = drainForIdentity(db, "k1", LATER);
    expect(drained.map((r) => r.message)).toEqual(["a", "b"]);
    expect(drained.every((r) => r.status === "drained")).toBe(true);
    expect(drainForIdentity(db, "k1", LATER)).toEqual([]);
    expect(pendingForIdentity(db, "k1")).toEqual([]);
  });

  test("history returns both pending and drained, oldest first", () => {
    const db = openCatalogue(":memory:");
    sendMessage(db, "k1", "first", "s", NOW);
    sendMessage(db, "k1", "second", "s", NOW);
    drainForIdentity(db, "k1", LATER);
    sendMessage(db, "k1", "third", "s", NOW);
    const h = historyForIdentity(db, "k1");
    expect(h.map((r) => r.message)).toEqual(["first", "second", "third"]);
    expect(h.map((r) => r.status)).toEqual(["drained", "drained", "pending"]);
  });

  test("messages segregate by identity_key", () => {
    const db = openCatalogue(":memory:");
    sendMessage(db, "k1", "for k1", "s", NOW);
    sendMessage(db, "k2", "for k2", "s", NOW);
    expect(pendingForIdentity(db, "k1").map((r) => r.message)).toEqual(["for k1"]);
    expect(pendingForIdentity(db, "k2").map((r) => r.message)).toEqual(["for k2"]);
  });

  test("pendingCountByIdentity aggregates by cluster", () => {
    const db = openCatalogue(":memory:");
    // Register two identities in the same cluster.
    db.query(
      `INSERT INTO identities (identity_key, cluster, role, kind, created_at, updated_at)
       VALUES ('c:r:a', 'c', 'r', 'fleet', $now, $now), ('c:r:b', 'c', 'r', 'fleet', $now, $now)`,
    ).run({ $now: NOW });
    sendMessage(db, "c:r:a", "one", "s", NOW);
    sendMessage(db, "c:r:a", "two", "s", NOW);
    sendMessage(db, "c:r:b", "just one", "s", NOW);
    const counts = pendingCountByIdentity(db, "c");
    expect(counts.get("c:r:a")).toBe(2);
    expect(counts.get("c:r:b")).toBe(1);
  });

  test("purgeDrainedBefore removes drained but not pending", () => {
    const db = openCatalogue(":memory:");
    sendMessage(db, "k1", "old", "s", NOW);
    drainForIdentity(db, "k1", "2026-07-14T12:03:00Z");
    sendMessage(db, "k1", "still pending", "s", NOW);
    // Drained rows with drained_at < 12:04 are removed; pending is untouched.
    const removed = purgeDrainedBefore(db, "2026-07-14T12:04:00Z");
    expect(removed).toBe(1);
    expect(pendingForIdentity(db, "k1").length).toBe(1);
    expect(pendingForIdentity(db, "k1")[0]!.message).toBe("still pending");
  });
});

describe("migrateFileInboxesToDb", () => {
  test("migrates a fleet PR inbox into the table", () => {
    const runtime = mkdtempSync(join(tmpdir(), "inbox-migrate-"));
    try {
      // Seed a filesystem inbox at the pre-refactor layout.
      const inboxDir = join(
        runtime,
        "clusters",
        "pr-watch",
        "identities",
        "pr-agent",
        "owner_repo-12345",
        "inbox",
      );
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(
        join(inboxDir, "20260714T120000Z-orchestrator.md"),
        "<!-- ccs-from: orchestrator -->\nfirst task\n",
      );
      writeFileSync(
        join(inboxDir, "20260714T120100Z-orchestrator.md"),
        "<!-- ccs-from: orchestrator -->\nsecond task\n",
      );
      const db = openCatalogue(":memory:");
      const count = migrateFileInboxesToDb(db, runtime);
      expect(count).toBe(2);
      const key = "pr-watch:pr-agent:owner/repo#12345";
      const rows = pendingForIdentity(db, key);
      expect(rows.map((r) => r.message.trim())).toEqual(["first task", "second task"]);
      expect(rows.every((r) => r.fromRole === "orchestrator")).toBe(true);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test("second run is a no-op (dir renamed to .migrated)", () => {
    const runtime = mkdtempSync(join(tmpdir(), "inbox-migrate-"));
    try {
      const inboxDir = join(
        runtime,
        "clusters",
        "pr-watch",
        "identities",
        "pr-agent",
        "owner_repo-42",
        "inbox",
      );
      mkdirSync(inboxDir, { recursive: true });
      writeFileSync(join(inboxDir, "20260714T120000Z-orchestrator.md"), "hey\n");
      const db = openCatalogue(":memory:");
      expect(migrateFileInboxesToDb(db, runtime)).toBe(1);
      expect(migrateFileInboxesToDb(db, runtime)).toBe(0);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });
});
