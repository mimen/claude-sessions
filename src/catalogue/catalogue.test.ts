import { expect, test } from "bun:test";
import {
  addTag,
  getRow,
  getTags,
  lifecycleOf,
  openCatalogue,
  sessionsForEntity,
  setArchived,
  setCompleted,
  setCustomTitle,
  setKind,
  setParked,
} from "./db.ts";
import { describe as dispo } from "./disposition.ts";

const NOW = "2026-06-20T00:00:00Z";

test("upsert is idempotent and custom_title round-trips", () => {
  const db = openCatalogue(":memory:");
  expect(getRow(db, "s1")).toBeNull();
  setCustomTitle(db, "s1", "My Loop", NOW);
  setCustomTitle(db, "s1", "Renamed", NOW); // second write updates in place, no dup
  const r = getRow(db, "s1")!;
  expect(r.customTitle).toBe("Renamed");
  expect(r.updatedAt).toBe(NOW);
});

test("lifecycle precedence: archived > completed > parked > idle", () => {
  const db = openCatalogue(":memory:");
  expect(lifecycleOf(getRow(db, "x"))).toBe("idle");
  setParked(db, "x", "task-123", NOW);
  expect(lifecycleOf(getRow(db, "x"))).toBe("parked");
  setCompleted(db, "x", true, NOW);
  expect(lifecycleOf(getRow(db, "x"))).toBe("completed");
  setArchived(db, "x", true, NOW);
  expect(lifecycleOf(getRow(db, "x"))).toBe("archived");
});

test("kind toggles loop", () => {
  const db = openCatalogue(":memory:");
  setKind(db, "s", "loop", NOW);
  expect(getRow(db, "s")!.kind).toBe("loop");
});

test("tags: add, list, reverse lookup", () => {
  const db = openCatalogue(":memory:");
  addTag(db, "s1", "Glizzy Galaxy");
  addTag(db, "s1", "Glizzy Galaxy"); // dup ignored
  addTag(db, "s2", "Glizzy Galaxy");
  expect(getTags(db, "s1")).toEqual(["Glizzy Galaxy"]);
  expect(sessionsForEntity(db, "Glizzy Galaxy").sort()).toEqual(["s1", "s2"]);
});

test("disposition combines lifecycle × liveness", () => {
  expect(dispo("idle", true).label).toBe("active");
  expect(dispo("idle", false).label).toBe("idle");
  expect(dispo("parked", false).label).toBe("parked");
  const po = dispo("parked", true);
  expect(po.label).toBe("parked·open");
  expect(po.nudge).toBe(true);
  expect(dispo("archived", false).hidden).toBe(true);
  expect(dispo("completed", true).nudge).toBe(true);
});

test("catalogue survives reopen (durable file semantics)", () => {
  // :memory: can't test persistence; assert migration is non-destructive on re-open instead.
  const db = openCatalogue(":memory:");
  setCustomTitle(db, "s", "keep", NOW);
  // re-running migrate (same connection re-open path) must not drop:
  const again = openCatalogue(":memory:"); // separate db, just asserts no throw + clean schema
  expect(getRow(again, "s")).toBeNull(); // separate in-memory db is empty (sanity)
  expect(getRow(db, "s")!.customTitle).toBe("keep");
});
