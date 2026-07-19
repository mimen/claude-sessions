import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClusterDoc } from "./cluster-state.ts";

// The CLI resolves the runtime root from HOME, so we point HOME at a temp dir per test.
import { stateCommand } from "./state-command.ts";

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

describe("ccs state CLI arg parsing", () => {
  test("doc name is NOT confused with a flag's value (regression)", () => {
    withHome((root) => {
      // `--cluster pr-watch board`: 'board' is the name, 'pr-watch' is --cluster's value
      const rc = stateCommand(["set", "--cluster", "pr-watch", "board", "--json", '{"tick":1}', "--source", "control"]);
      expect(rc).toBe(0);
      const doc = readClusterDoc(root, "pr-watch", "board");
      expect(doc?.data).toEqual({ tick: 1 });
      expect(doc?.source).toBe("control");
    });
  });

  test("name works regardless of flag order", () => {
    withHome((root) => {
      stateCommand(["set", "board", "--cluster", "pr-watch", "--json", '{"n":2}']);
      expect(readClusterDoc(root, "pr-watch", "board")?.data).toEqual({ n: 2 });
    });
  });

  test("merge only touches given fields", () => {
    withHome((root) => {
      stateCommand(["set", "--cluster", "pr-watch", "board", "--json", '{"a":1,"b":2}']);
      stateCommand(["merge", "--cluster", "pr-watch", "board", "--json", '{"b":20}']);
      expect(readClusterDoc(root, "pr-watch", "board")?.data).toEqual({ a: 1, b: 20 });
    });
  });
});
