import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDoc, readDoc, mergeFields, SCHEMA_VERSION } from "./store.ts";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "ccs-state-"));
}
const NOW = "2026-07-10T00:00:00Z";

describe("writeDoc / readDoc", () => {
  test("round-trips a document with the value under .data", () => {
    const dir = fresh();
    try {
      const p = join(dir, "board.json");
      writeDoc(p, { prs: [1, 2, 3] }, { now: NOW, source: "control" });
      const doc = readDoc(p);
      expect(doc?.data).toEqual({ prs: [1, 2, 3] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stamps schemaVersion, updated_at, and source on every write (ADR-0031)", () => {
    const dir = fresh();
    try {
      const p = join(dir, "x.json");
      writeDoc(p, { a: 1 }, { now: NOW, source: "scout" });
      const raw = JSON.parse(readFileSync(p, "utf8"));
      expect(raw.schemaVersion).toBe(SCHEMA_VERSION);
      expect(raw.updatedAt).toBe(NOW);
      expect(raw.source).toBe("scout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reading a missing file returns null (absence is not an error)", () => {
    const dir = fresh();
    try {
      expect(readDoc(join(dir, "nope.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("write is atomic: no .tmp left behind, target is complete", () => {
    const dir = fresh();
    try {
      const p = join(dir, "y.json");
      writeDoc(p, { ok: true }, { now: NOW, source: "s" });
      const files = readdirSync(dir);
      expect(files).toEqual(["y.json"]); // no y.json.tmp
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a corrupt file is quarantined and read returns null (ADR-0031)", () => {
    const dir = fresh();
    try {
      const p = join(dir, "bad.json");
      writeFileSync(p, "{ this is not json");
      expect(readDoc(p)).toBeNull();
      // the corrupt file was moved aside, not left to poison future reads
      const quarantined = readdirSync(dir).filter((f) => f.startsWith("bad.json.corrupt"));
      expect(quarantined.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unknown (future) schemaVersion is refused, not best-guessed", () => {
    const dir = fresh();
    try {
      const p = join(dir, "future.json");
      writeFileSync(p, JSON.stringify({ schemaVersion: 9999, data: { a: 1 } }));
      expect(readDoc(p)).toBeNull(); // refuse; don't silently misread
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeFields (single-writer-per-field, ADR-0031/0004)", () => {
  test("updates only the given fields, leaving others intact", () => {
    const dir = fresh();
    try {
      const p = join(dir, "sessions.json");
      writeDoc(p, { a: 1, b: 2, c: 3 }, { now: NOW, source: "control" });
      mergeFields(p, { b: 20 }, { now: NOW, source: "concierge" });
      expect(readDoc(p)?.data).toEqual({ a: 1, b: 20, c: 3 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merge onto a missing file creates it with just those fields", () => {
    const dir = fresh();
    try {
      const p = join(dir, "new.json");
      mergeFields(p, { x: 1 }, { now: NOW, source: "s" });
      expect(readDoc(p)?.data).toEqual({ x: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
