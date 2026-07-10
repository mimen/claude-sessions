import { expect, test } from "bun:test";
import { interpretSpawnLocation, syntheticRow } from "./spawn-location.ts";

const HOME = { homeDir: "/roles/control", requestedCwd: null };
const WT = { homeDir: "/roles/pr-agent", requestedCwd: "/wt/pr-12080" };

test("no config → null cwd (caller falls back to home_dir default)", () => {
  expect(interpretSpawnLocation(null, HOME)).toEqual({ cwd: null });
  expect(interpretSpawnLocation({}, HOME)).toEqual({ cwd: null });
});

test('"role-dir" resolves to the role home_dir', () => {
  expect(interpretSpawnLocation({ location: "role-dir" }, HOME)).toEqual({ cwd: "/roles/control" });
});

test('"role-dir" with no home_dir is an error', () => {
  const r = interpretSpawnLocation({ location: "role-dir" }, { homeDir: null, requestedCwd: null });
  expect(r.cwd).toBeNull();
  expect(r.error).toContain("no home_dir");
});

test('"worktree" resolves to the passed --cwd', () => {
  expect(interpretSpawnLocation({ location: "worktree" }, WT)).toEqual({ cwd: "/wt/pr-12080" });
});

test('"worktree" with no --cwd is an error (determinism: fail loud)', () => {
  const r = interpretSpawnLocation({ location: "worktree" }, { homeDir: "/roles/pr-agent", requestedCwd: null });
  expect(r.cwd).toBeNull();
  expect(r.error).toContain("no --cwd");
});

test("an absolute path is used verbatim", () => {
  expect(interpretSpawnLocation({ location: "/custom/dir" }, HOME)).toEqual({ cwd: "/custom/dir" });
});

test("an unknown mode is an error", () => {
  const r = interpretSpawnLocation({ location: "somewhere" }, HOME);
  expect(r.error).toContain("not a known mode");
});

test("syntheticRow carries the launch facts the resolver keys on", () => {
  const row = syntheticRow({ system: "pr-watch", role: "pr-agent", epicId: "e1", prNumber: 5, prRepo: "a/b" });
  expect(row.system).toBe("pr-watch");
  expect(row.role).toBe("pr-agent");
  expect(row.epicId).toBe("e1");
  expect(row.prNumber).toBe(5);
  expect(row.prRepo).toBe("a/b");
});
