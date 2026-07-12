import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveResumeCwd } from "./command.ts";
import { encodePath, decodeStorageFolder } from "./locate.ts";
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
  if ("error" in out) throw new Error("should succeed");
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
  if ("error" in out) throw new Error("should succeed");
  expect(out.cwd).toBe(real);
  expect(out.note).toContain("no longer maps");

  rmSync(base, { recursive: true, force: true });
});

// C2: the decoder is bounded — a non-existent deep folder returns Ok(null) without hanging.
test("decodeStorageFolder returns Ok(null) (bounded) for an unmatched folder", () => {
  const result = decodeStorageFolder("-nonexistent-" + "x".repeat(50));
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBeNull();
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
