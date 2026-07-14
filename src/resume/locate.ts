import { readdirSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { type Result, ok, err } from "../result.ts";
import { log } from "../logger.ts";

/**
 * Claude Code stores a session at `~/.claude/projects/<folder>/<id>.jsonl`, where
 * `<folder> = encode(realpath(cwd_at_creation))` and `encode` maps every non-alphanumeric
 * char to `-`. On resume it looks under `encode(realpath(current_dir))`. So a session is
 * resumable only from the directory whose encoded realpath equals its storage folder — which
 * is NOT always the recorded `cwd` (it drifts when a symlinked cwd is later changed/removed).
 * The storage folder is therefore authoritative.
 */

/** Mirror Claude Code's path → folder encoding. */
export function encodePath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** The storage folder name for a session file path (the dir the file lives in). */
export function storageFolderOf(filePath: string): string {
  return basename(dirname(filePath));
}

/**
 * Resolve a storage folder back to the real directory that encodes to it, by walking the
 * filesystem (the encoding is lossy, but real directory names disambiguate). Returns Ok(path)
 * if found, Ok(null) if absent (the dir was deleted/moved), or Err if the filesystem walk
 * fails (permission error, I/O error) — distinguishing unreadable from absent per ADR-0066.
 */
export function decodeStorageFolder(folder: string): Result<string | null, Error> {
  // Real Claude Code storage folders encode an absolute path, so they always start with `-`
  // (the leading `/`). Anything else is not a decodable folder.
  if (!folder.startsWith("-")) return ok(null);
  return walk("/", folder.slice(1), 0, { n: MAX_NODES });
}

// Bounds so the fallback walk can never freeze the resume path (see review C2). The encoded
// folder has one segment per path component, so depth is naturally small; the node budget
// guards against pathological fan-out (many same-encoding siblings on a huge/slow tree).
const MAX_DEPTH = 24;
const MAX_NODES = 5000;

function walk(base: string, remaining: string, depth: number, budget: { n: number }): Result<string | null, Error> {
  if (remaining === "") return ok(base);
  if (depth > MAX_DEPTH || budget.n <= 0) return ok(null);
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name));
  } catch (error) {
    log.error("Failed to read directory during storage folder walk", {
      base,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  for (const name of names) {
    if (budget.n <= 0) return ok(null);
    budget.n--;
    const enc = encodePath(name);
    const full = join(base, name);
    if (enc === remaining) return ok(full);
    if (remaining.startsWith(enc + "-")) {
      const result = walk(full, remaining.slice(enc.length + 1), depth + 1, budget);
      if (!result.ok) return result; // propagate error
      if (result.value) return result;
    }
  }
  return ok(null);
}

/**
 * The directory to launch `claude --resume` from so it actually finds the session: the real
 * dir whose encoded realpath matches the file's storage folder. Returns Ok(dir) if found,
 * Ok(null) if absent (deleted/moved), or Err if the filesystem walk fails — distinguishing
 * unreadable from absent per ADR-0066. Caller must fail closed on Err.
 */
export function locateLaunchDir(filePath: string): Result<string | null, Error> {
  const folder = storageFolderOf(filePath);
  const decodedResult = decodeStorageFolder(folder);
  if (!decodedResult.ok) return decodedResult; // propagate error
  const decoded = decodedResult.value;
  if (!decoded) return ok(null);
  // Sanity: confirm it round-trips (guards against a lossy-encoding false match). Bug fix
  // (2026-07-14 REVIEW.md top-5 #1): the old form was `? decoded : decoded` — a no-op
  // tautology that let a false match through. Now: a non-round-tripping candidate returns
  // null so the caller falls back to the recorded cwd or a safer default.
  try {
    if (encodePath(realpathSync(decoded)) === folder) {
      return ok(decoded);
    }
    log.warn("Storage folder walk found a candidate that does not round-trip", {
      decoded,
      folder,
    });
    return ok(null);
  } catch (error) {
    log.error("Failed to verify launch directory via realpath", {
      decoded,
      folder,
      error: error instanceof Error ? error.message : String(error),
    });
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
