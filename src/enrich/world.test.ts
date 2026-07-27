import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readWorldState, renderWorldBlock } from "./world.ts";

/**
 * The git facts here are read from plumbing FILES, never from a subprocess — `provenance.test.ts`
 * forbids spawning across this directory. These tests therefore build real `.git` layouts on disk
 * rather than real repositories, which is also the only way to exercise the packed-refs and
 * Gitfile-worktree paths deterministically.
 */

let dir: string;
let index: Database;

/** A minimal but structurally honest `.git` directory. */
function makeRepo(root: string, opts: { head?: string; looseBranches?: string[]; packed?: string[] } = {}): void {
  const gitDir = join(root, ".git");
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${opts.head ?? "master"}\n`);
  for (const branch of opts.looseBranches ?? []) {
    const path = join(gitDir, "refs", "heads", branch);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "0".repeat(40) + "\n");
  }
  if (opts.packed) {
    const lines = ["# pack-refs with: peeled fully-peeled sorted"];
    for (const branch of opts.packed) lines.push(`${"a".repeat(40)} refs/heads/${branch}`);
    writeFileSync(join(gitDir, "packed-refs"), lines.join("\n") + "\n");
  }
}

function seedIndex(rows: { id: string; cwd: string; lastTs: string; subagent?: boolean }[]): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE sessions (session_id TEXT PRIMARY KEY, cwd TEXT, last_ts TEXT, is_subagent INTEGER)");
  for (const row of rows) {
    db.query("INSERT INTO sessions VALUES ($id, $cwd, $ts, $sub)").run({
      $id: row.id, $cwd: row.cwd, $ts: row.lastTs, $sub: row.subagent ? 1 : 0,
    });
  }
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccs-world-"));
  index = seedIndex([]);
});
afterEach(() => {
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("repo detection", () => {
  test("a cwd that no longer exists is reported as such", () => {
    const world = readWorldState(index, {
      sessionId: "s1", cwd: join(dir, "gone"), branch: "feat/x", lastTs: null,
    });
    expect(world.repo.kind).toBe("missing-cwd");
    expect(renderWorldBlock(world)).toMatch(/NO LONGER EXISTS/);
  });

  test("a real directory that is not a repository says so plainly", () => {
    // A third of the enriched store is like this — vault work, the home directory, ad-hoc dirs —
    // and reporting it as a repo with no branches would be worse than saying nothing.
    const world = readWorldState(index, { sessionId: "s1", cwd: dir, branch: null, lastTs: null });
    expect(world.repo.kind).toBe("no-git");
    expect(renderWorldBlock(world)).toMatch(/not a git repository/);
  });

  test("reads the checked-out branch from HEAD", () => {
    makeRepo(dir, { head: "master" });
    const world = readWorldState(index, { sessionId: "s1", cwd: dir, branch: null, lastTs: null });
    expect(world.repo).toMatchObject({ kind: "git", headBranch: "master" });
  });

  test("a detached HEAD is null, not a crash and not a fake branch", () => {
    makeRepo(dir);
    writeFileSync(join(dir, ".git", "HEAD"), "9".repeat(40) + "\n");
    const world = readWorldState(index, { sessionId: "s1", cwd: dir, branch: null, lastTs: null });
    expect(world.repo).toMatchObject({ kind: "git", headBranch: null });
  });
});

describe("branch existence", () => {
  test("a loose ref counts as present", () => {
    makeRepo(dir, { looseBranches: ["feat/live"] });
    const world = readWorldState(index, { sessionId: "s1", cwd: dir, branch: "feat/live", lastTs: null });
    expect(world.repo).toMatchObject({ sessionBranchExists: true });
  });

  test("a PACKED ref counts as present", () => {
    // The bug this pins: after gc, long-lived branches have no loose file at all. Checking only
    // refs/heads/ would report them deleted — and "branch deleted" is the single strongest input
    // to the verdict this feeds, so a false positive there mislabels live work as landed.
    makeRepo(dir, { packed: ["feat/packed-away"] });
    const world = readWorldState(index, {
      sessionId: "s1", cwd: dir, branch: "feat/packed-away", lastTs: null,
    });
    expect(world.repo).toMatchObject({ sessionBranchExists: true });
  });

  test("a branch in neither store is reported deleted", () => {
    makeRepo(dir, { looseBranches: ["other"], packed: ["another"] });
    const world = readWorldState(index, { sessionId: "s1", cwd: dir, branch: "feat/gone", lastTs: null });
    expect(world.repo).toMatchObject({ sessionBranchExists: false });
    expect(renderWorldBlock(world)).toMatch(/DELETED since/);
  });

  test("a session that recorded no branch asks no branch question", () => {
    makeRepo(dir);
    const world = readWorldState(index, { sessionId: "s1", cwd: dir, branch: null, lastTs: null });
    expect(world.repo).toMatchObject({ sessionBranchExists: null });
    expect(renderWorldBlock(world)).not.toMatch(/branch this session ran on/);
  });

  test("a Gitfile worktree resolves refs through commondir", () => {
    // Half of CCS's own work happens in linked worktrees, where `.git` is a file. Failing to
    // follow it would report every worktree session as "not a git repository".
    const mainGit = join(dir, "main", ".git");
    // A slashed branch name is a nested DIRECTORY under refs/heads, not a file with a slash in
    // its name — which is exactly the layout `branchExists` has to resolve.
    mkdirSync(join(mainGit, "refs", "heads", "feat"), { recursive: true });
    writeFileSync(join(mainGit, "refs", "heads", "feat", "shared"), "0".repeat(40) + "\n");
    const linked = join(dir, "wt");
    const linkedGit = join(mainGit, "worktrees", "wt");
    mkdirSync(linkedGit, { recursive: true });
    writeFileSync(join(linkedGit, "commondir"), "../..\n");
    writeFileSync(join(linkedGit, "HEAD"), "ref: refs/heads/feat/shared\n");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, ".git"), `gitdir: ${linkedGit}\n`);

    const world = readWorldState(index, {
      sessionId: "s1", cwd: linked, branch: "feat/shared", lastTs: null,
    });
    expect(world.repo).toMatchObject({ kind: "git", sessionBranchExists: true });
  });

  test("a broken Gitfile degrades to no-git rather than throwing", () => {
    mkdirSync(join(dir, "broken"), { recursive: true });
    writeFileSync(join(dir, "broken", ".git"), "gitdir: /nowhere/at/all\n");
    const world = readWorldState(index, {
      sessionId: "s1", cwd: join(dir, "broken"), branch: "x", lastTs: null,
    });
    expect(world.repo.kind).toBe("no-git");
  });
});

describe("successor sessions", () => {
  const CWD = "/Users/mimen/Documents/milad-vault";

  test("counts only later, non-subagent sessions in the same directory", () => {
    index.close();
    index = seedIndex([
      { id: "self", cwd: CWD, lastTs: "2026-07-01T00:00:00.000Z" },
      { id: "earlier", cwd: CWD, lastTs: "2026-06-01T00:00:00.000Z" },
      { id: "later-1", cwd: CWD, lastTs: "2026-07-10T00:00:00.000Z" },
      { id: "later-2", cwd: CWD, lastTs: "2026-07-20T00:00:00.000Z" },
      { id: "later-sidechain", cwd: CWD, lastTs: "2026-07-25T00:00:00.000Z", subagent: true },
      { id: "elsewhere", cwd: "/tmp/other", lastTs: "2026-07-25T00:00:00.000Z" },
    ]);
    const world = readWorldState(index, {
      sessionId: "self", cwd: CWD, branch: null, lastTs: "2026-07-01T00:00:00.000Z",
    });
    expect(world.sessionsSince).toBe(2);
    expect(world.mostRecentSince).toBe("2026-07-20T00:00:00.000Z");
    expect(renderWorldBlock(world)).toMatch(/later sessions in this directory: 2/);
  });

  test("this signal works where git says nothing at all", () => {
    // The reason it carries the coverage: 412 of 466 enriched sessions have a successor, while
    // the branch check speaks for only 63.
    index.close();
    index = seedIndex([
      { id: "self", cwd: dir, lastTs: "2026-07-01T00:00:00.000Z" },
      { id: "later", cwd: dir, lastTs: "2026-07-20T00:00:00.000Z" },
    ]);
    const world = readWorldState(index, {
      sessionId: "self", cwd: dir, branch: null, lastTs: "2026-07-01T00:00:00.000Z",
    });
    expect(world.repo.kind).toBe("no-git");
    expect(world.sessionsSince).toBe(1);
  });

  test("a session with no recorded end time counts nothing rather than everything", () => {
    index.close();
    index = seedIndex([{ id: "other", cwd: dir, lastTs: "2026-07-20T00:00:00.000Z" }]);
    const world = readWorldState(index, { sessionId: "self", cwd: dir, branch: null, lastTs: null });
    expect(world.sessionsSince).toBe(0);
  });
});
