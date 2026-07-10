import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeClusterDoc,
  readClusterDoc,
  writeIdentityDoc,
  readIdentityDoc,
} from "./cluster-state.ts";

function fresh(): string {
  return mkdtempSync(join(tmpdir(), "ccs-cs-"));
}
const NOW = "2026-07-10T00:00:00Z";

describe("cluster-scoped state", () => {
  test("board/gate/etc round-trip under ~/.ccs/clusters/<c>/cluster/<name>.json", () => {
    const root = fresh();
    try {
      writeClusterDoc(root, "pr-watch", "board", { prs: [12113, 12120] }, { now: NOW, source: "control" });
      expect(readClusterDoc(root, "pr-watch", "board")?.data).toEqual({ prs: [12113, 12120] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two clusters don't collide on the same doc name", () => {
    const root = fresh();
    try {
      writeClusterDoc(root, "pr-watch", "board", { x: 1 }, { now: NOW, source: "a" });
      writeClusterDoc(root, "event-watch", "board", { x: 2 }, { now: NOW, source: "b" });
      expect(readClusterDoc(root, "pr-watch", "board")?.data).toEqual({ x: 1 });
      expect(readClusterDoc(root, "event-watch", "board")?.data).toEqual({ x: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing cluster doc reads null", () => {
    const root = fresh();
    try {
      expect(readClusterDoc(root, "pr-watch", "gate")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("identity-scoped state", () => {
  test("result/judgment round-trip keyed by responsibility", () => {
    const root = fresh();
    try {
      const r = { cluster: "pr-watch", role: "pr-agent", workUnit: "W-12345678" };
      writeIdentityDoc(root, r, "result", { status: "done", sha: "abc" }, { now: NOW, source: "pr-agent" });
      expect(readIdentityDoc(root, r, "result")?.data).toEqual({ status: "done", sha: "abc" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("different work-units of the same role keep separate state", () => {
    const root = fresh();
    try {
      const a = { cluster: "pr-watch", role: "pr-agent", workUnit: "W-1" };
      const b = { cluster: "pr-watch", role: "pr-agent", workUnit: "W-2" };
      writeIdentityDoc(root, a, "judgment", { v: "a" }, { now: NOW, source: "s" });
      writeIdentityDoc(root, b, "judgment", { v: "b" }, { now: NOW, source: "s" });
      expect(readIdentityDoc(root, a, "judgment")?.data).toEqual({ v: "a" });
      expect(readIdentityDoc(root, b, "judgment")?.data).toEqual({ v: "b" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a core singleton (no work-unit) keeps its own state", () => {
    const root = fresh();
    try {
      const control = { cluster: "pr-watch", role: "control" };
      writeIdentityDoc(root, control, "result", { lastTick: NOW }, { now: NOW, source: "control" });
      expect(readIdentityDoc(root, control, "result")?.data).toEqual({ lastTick: NOW });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
