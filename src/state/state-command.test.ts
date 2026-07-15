import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateCommand } from "./state-command.ts";

// ADR-0089 narrowed `ccs state` to `get` only — writes go through
// ccs identity/session/inbox now. These tests cover the read path + arg-parsing regressions.

function withHome<T>(fn: (root: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "ccs-cli-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(join(home, ".ccs"));
  } finally {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

function seedCluster(root: string, cluster: string, name: string, obj: unknown, source = "sensor"): void {
  const dir = join(root, "clusters", cluster, "cluster");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({ schemaVersion: 1, updatedAt: "2026-07-14T00:00:00Z", source, data: obj }),
  );
}

describe("ccs state get", () => {
  test("reads a seeded cluster-scoped doc", () => {
    withHome((root) => {
      seedCluster(root, "pr-watch", "board", { tick: 1 });
      const before = console.log;
      const captured: string[] = [];
      console.log = (m: string) => captured.push(m);
      try {
        const rc = stateCommand(["get", "--cluster", "pr-watch", "board"]);
        expect(rc).toBe(0);
        expect(JSON.parse(captured[0]!).data).toEqual({ tick: 1 });
      } finally {
        console.log = before;
      }
    });
  });

  test("prints null when the doc is absent", () => {
    withHome(() => {
      const before = console.log;
      const captured: string[] = [];
      console.log = (m: string) => captured.push(m);
      try {
        const rc = stateCommand(["get", "--cluster", "pr-watch", "no-such-doc"]);
        expect(rc).toBe(0);
        expect(captured[0]).toBe("null");
      } finally {
        console.log = before;
      }
    });
  });

  test("name is not confused with a flag value regardless of order", () => {
    withHome((root) => {
      seedCluster(root, "pr-watch", "board", { tick: 2 });
      const before = console.log;
      const captured: string[] = [];
      console.log = (m: string) => captured.push(m);
      try {
        stateCommand(["get", "board", "--cluster", "pr-watch"]);
        expect(JSON.parse(captured[0]!).data).toEqual({ tick: 2 });
      } finally {
        console.log = before;
      }
    });
  });
});

describe("ccs state — write verbs removed", () => {
  test("set errors out (ADR-0089 removed it)", () => {
    withHome(() => {
      const rc = stateCommand(["set", "--cluster", "pr-watch", "board", "--json", '{"n":1}']);
      expect(rc).toBe(1);
    });
  });

  test("merge errors out (ADR-0089 removed it)", () => {
    withHome(() => {
      const rc = stateCommand(["merge", "--cluster", "pr-watch", "board", "--json", '{"n":1}']);
      expect(rc).toBe(1);
    });
  });
});
