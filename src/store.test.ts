import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatBytes, scanStore } from "./store.ts";

test("formatBytes scales units", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1024)).toBe("1 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(298 * 1024 * 1024)).toBe("298 MB");
});

test("scanStore rejects source and directory symlinks that escape the configured store", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-store-safety-"));
  try {
    const store = join(root, "projects");
    const project = join(store, "project");
    const outside = join(root, "outside");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(project, "inside.jsonl"), "{}\n");
    writeFileSync(join(outside, "outside.jsonl"), "{}\n");
    symlinkSync(join(outside, "outside.jsonl"), join(project, "file-link.jsonl"));
    symlinkSync(outside, join(store, "directory-link"));

    const result = scanStore(store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((file) => file.sessionId)).toEqual(["inside"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
