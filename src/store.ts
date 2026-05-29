import { statSync } from "node:fs";
import { Glob } from "bun";
import { type Result, ok, err } from "./result.ts";

/** A Session transcript file discovered in the Store, with cheap stat metadata. */
export interface StoredSessionFile {
  /** Absolute path to the `<uuid>.jsonl` file. */
  readonly path: string;
  /** Session ID (the filename without `.jsonl`). */
  readonly sessionId: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * Enumerate every Session file under the Store. Claude Code keeps each Session as one
 * `<uuid>.jsonl`, grouped one level deep by encoded cwd — we glob recursively to be safe.
 * This is a `stat`-only pass: no file contents are read (parsing happens in M2).
 */
export function scanStore(storePath: string): Result<StoredSessionFile[]> {
  const files: StoredSessionFile[] = [];
  try {
    const glob = new Glob("**/*.jsonl");
    for (const path of glob.scanSync({ cwd: storePath, absolute: true })) {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      const name = path.slice(path.lastIndexOf("/") + 1);
      files.push({
        path,
        sessionId: name.replace(/\.jsonl$/, ""),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    }
  } catch (e) {
    return err(new Error(`Failed to scan store at ${storePath}: ${(e as Error).message}`));
  }
  return ok(files);
}

/** Format a byte count as a human-readable size (e.g. "298 MB"). */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? size : Math.round(size * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
