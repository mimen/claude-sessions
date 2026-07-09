import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveResumeCwd } from "./command.ts";
import { encodePath, decodeStorageFolder, decodeStorageFolderAll, locateLaunchDirs } from "./locate.ts";
import { handoffInline } from "./inline.ts";
import type { SessionRow } from "../index/index.ts";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "id", host: "h", path: "/p", cwd: "/c", projectRoot: "/c",
    projectName: "c", branch: null, version: null, firstTs: null, lastTs: null,
    msgCount: 0, fileSize: 0, title: "t", titleSource: "fallback",
    isSubagent: false, parentSessionId: null, resumeId: "id", costUSD: 0, tokInput: 0, tokOutput: 0, tokCacheRead: 0, tokCacheWrite: 0, costByModel: {}, userTurns: 0, tickIntervalSec: 0, ...over,
  };
}

// C1: when the recorded cwd exists AND encodes to the storage folder, prefer it (no walk),
// which also avoids lossy-encoding collisions with sibling dirs.
test("resolveResumeCwd prefers a valid recorded cwd that matches the storage folder", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-rf-")));
  const real = join(base, "project-foo");
  const sibling = join(base, "project.foo"); // encodes identically to project-foo
  mkdirSync(real, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  const folder = encodePath(real);
  const path = join(base, ".projects", folder, "s.jsonl");

  const out = resolveResumeCwd(row({ path, cwd: real, projectRoot: real }));
  expect(out.cwd).toBe(real); // the real recorded cwd, not the same-encoding sibling
  expect(out.note).toBeNull();

  rmSync(base, { recursive: true, force: true });
});

// C1 cont.: a drifted cwd (no longer matching) falls back to the located dir with a note.
test("resolveResumeCwd walks to the storage dir when the recorded cwd has drifted", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-rf-")));
  const real = join(base, "My Vault");
  mkdirSync(real, { recursive: true });
  const path = join(base, ".projects", encodePath(real), "s.jsonl");

  const out = resolveResumeCwd(row({ path, cwd: "/gone/old/path", projectRoot: "/gone/old" }));
  expect(out.cwd).toBe(real);
  expect(out.note).toContain("no longer maps");

  rmSync(base, { recursive: true, force: true });
});

// C2: the decoder is bounded — a non-existent deep folder returns null without hanging.
test("decodeStorageFolder returns null (bounded) for an unmatched folder", () => {
  expect(decodeStorageFolder("-nonexistent-" + "x".repeat(50))).toBeNull();
});

// C2 cont.: the DEPTH bound holds against a real tree deeper than the walk allows — the walk
// gives up (null) instead of descending forever; the caller's recorded-cwd path still works.
test("decodeStorageFolder stays depth-bounded on a real deep fixture tree", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-deep-")));
  let deep = base;
  for (let i = 0; i < 30; i++) deep = join(deep, `d${i}`); // 30 levels under tmp > MAX_DEPTH total
  mkdirSync(deep, { recursive: true });

  const started = Date.now();
  expect(decodeStorageFolder(encodePath(deep))).toBeNull(); // bound hit, not found
  expect(Date.now() - started).toBeLessThan(2000); // and it gave up fast

  // The recorded-cwd fast path is how such a session still resumes correctly.
  const path = join(base, ".projects", encodePath(deep), "s.jsonl");
  const out = resolveResumeCwd(row({ path, cwd: deep, projectRoot: deep }));
  expect(out.cwd).toBe(deep);
  expect(out.note).toBeNull();

  rmSync(base, { recursive: true, force: true });
});

// H1 residue: a same-encoding SYMLINK is a false match — claude computes encode(realpath(cwd)),
// so resuming from it would not find the session. The old round-trip "guard" returned it anyway
// (`? decoded : decoded`); the walk must reject it.
test("decodeStorageFolder rejects a symlink whose realpath encodes differently", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-sym-")));
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  const decoy = join(base, "a b"); // encodes like `a.b` / `a-b` would
  symlinkSync(elsewhere, decoy);

  const folder = encodePath(decoy); // what claude WOULD have stored had `a b` been real
  expect(decodeStorageFolder(folder)).toBeNull(); // decoy rejected, nothing else matches

  rmSync(base, { recursive: true, force: true });
});

// H1 residue cont.: with the decoy rejected, the walk keeps searching and finds the REAL dir.
test("decodeStorageFolder finds the real dir past a same-encoding symlink decoy", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-sym2-")));
  const elsewhere = join(base, "zzz");
  mkdirSync(elsewhere, { recursive: true });
  const real = join(base, "a.b");
  mkdirSync(real, { recursive: true });
  symlinkSync(elsewhere, join(base, "a b")); // same encoding as a.b, wrong realpath

  expect(decodeStorageFolder(encodePath(real))).toBe(real);

  rmSync(base, { recursive: true, force: true });
});

// H1 residue cont.: TWO real dirs with the same encoding = genuine ambiguity; both are
// reported and resolveResumeCwd says so instead of silently picking one.
test("ambiguous encodings are surfaced, not silently resolved", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ccs-amb-")));
  const flat = join(base, "x-y");
  const nested = join(base, "x", "y");
  mkdirSync(flat, { recursive: true });
  mkdirSync(nested, { recursive: true });

  const folder = encodePath(flat); // === encodePath(nested)
  const path = join(base, ".projects", folder, "s.jsonl");
  const all = decodeStorageFolderAll(folder);
  expect(all.sort()).toEqual([flat, nested].sort());
  expect(locateLaunchDirs(path).length).toBe(2);

  const out = resolveResumeCwd(row({ path, cwd: "/gone/old", projectRoot: "/gone" }));
  expect([flat, nested]).toContain(out.cwd); // resume still works from either
  expect(out.note).toContain("ambiguous");

  rmSync(base, { recursive: true, force: true });
});

// H2: inline resume reports a non-zero code when the binary can't be run, not success.
test("handoffInline returns 127 when the command is missing", () => {
  const code = handoffInline({
    argv: ["definitely-not-a-real-binary-xyz", "--resume", "id"],
    cwd: tmpdir(),
    shell: "definitely-not-a-real-binary-xyz --resume id",
  });
  expect(code).toBe(127);
});

// H1: reindex skips an unreadable transcript instead of aborting the whole batch.
test("reindexStore skips a bad file and indexes the rest", async () => {
  const { openIndex } = await import("../index/schema.ts");
  const { reindexStore, listByRecency } = await import("../index/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "ccs-rf-store-"));
  const good = join(dir, "good.jsonl");
  writeFileSync(good, JSON.stringify({ type: "user", cwd: dir, message: { content: "hi" } }) + "\n");
  const badPath = join(dir, "bad.jsonl"); // referenced but never created → parse throws

  const db = openIndex(":memory:");
  const files = [
    { path: good, sessionId: "good", sizeBytes: 10, mtimeMs: 1 },
    { path: badPath, sessionId: "bad", sizeBytes: 10, mtimeMs: 1 },
  ];
  const stats = await reindexStore(db, files, "h");
  rmSync(dir, { recursive: true, force: true });

  expect(stats.parsed).toBe(1);
  expect(listByRecency(db, true).map((r) => r.sessionId)).toContain("good");
});
