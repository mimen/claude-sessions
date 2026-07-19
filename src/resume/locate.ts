import { readdirSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { type Result, ok, err } from "../result.ts";
import { log } from "../logger.ts";

/**
 * Claude Code stores a session at `~/.claude/projects/<folder>/<id>.jsonl`, where
 * `<folder> = encode(realpath(cwd_at_creation))` and `encode` maps every non-alphanumeric
 * char to `-`. On resume it looks under `encode(realpath(current_dir))`. So a session is
 * resumable only from the directory whose encoded realpath equals its storage folder — which
 * is NOT always the recorded `cwd` (it drifts when a symlinked cwd is later changed/removed,
 * the "No conversation found" bug). The storage folder is therefore authoritative.
 *
 * Symlinks never surface here: claude's getcwd is already symlink-resolved when the folder is
 * derived, and the walk's dirent filter skips symlinks (a Dirent for a symlink-to-dir reports
 * isDirectory() = false). encodesTo() is the single statement of the mapping rule and doubles
 * as the backstop should either of those facts ever change.
 */

/** Mirror Claude Code's path → folder encoding. */
export function encodePath(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** The storage folder name for a session file path (the dir the file lives in). */
export function storageFolderOf(filePath: string): string {
  return basename(dirname(filePath));
}

/** Whether launching claude in `dir` surfaces sessions stored under `folder`. */
export function encodesTo(dir: string, folder: string): boolean {
  try {
    return encodePath(realpathSync(dir)) === folder;
  } catch {
    return encodePath(dir) === folder;
  }
}

/** A resolved launch dir, with everything the caller needs to be honest about it. */
export interface Located {
  readonly dir: string;
  /** A second verified match — the lossy encoding is genuinely ambiguous (/a-b vs /a/b). */
  readonly ambiguousWith: string | null;
  /** The bounded search gave up somewhere: a further match can't be ruled out. */
  readonly exhausted: boolean;
}

// Bounds so the fallback walk can never freeze the resume path (see review C2). The encoded
// folder has one segment per path component, so depth is naturally small; the node budget
// guards against pathological fan-out (many same-encoding siblings on a huge/slow tree).
const MAX_DEPTH = 24;
const MAX_NODES = 5000;
const MAX_MATCHES = 2; // two is enough to know the encoding is ambiguous

/**
 * Resolve a storage folder back to verified real directories by walking the filesystem. Returns
 * Ok(Located) if found, Ok(null) if absent, or Err if a directory cannot be read — distinguishing
 * unreadable from absent per ADR-0066. The search continues after its first match so a lossy
 * encoding collision is detected rather than silently decided by readdir order.
 */
export function decodeStorageFolder(folder: string): Result<Located | null, Error> {
  if (!folder.startsWith("-")) return ok(null);
  if (folder === "-") {
    return ok(encodesTo("/", folder) ? { dir: "/", ambiguousWith: null, exhausted: false } : null);
  }

  const matches: string[] = [];
  const budget = { nodes: MAX_NODES, exhausted: false };

  const walk = (base: string, remaining: string, depth: number): Result<void, Error> => {
    if (matches.length >= MAX_MATCHES) return ok(undefined);
    if (depth > MAX_DEPTH || budget.nodes <= 0) {
      budget.exhausted = true;
      return ok(undefined);
    }

    let names: string[];
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => String(entry.name));
    } catch (error) {
      const detail = error instanceof Error ? error : new Error(String(error));
      log.error("Failed to read directory during storage folder walk", { base, error: detail.message });
      return err(detail);
    }

    for (const name of names) {
      if (matches.length >= MAX_MATCHES) return ok(undefined);
      if (budget.nodes <= 0) {
        budget.exhausted = true;
        return ok(undefined);
      }
      budget.nodes--;
      const encodedName = encodePath(name);
      const full = join(base, name);
      if (encodedName === remaining) {
        if (encodesTo(full, folder)) matches.push(full);
      } else if (remaining.startsWith(encodedName + "-")) {
        const result = walk(full, remaining.slice(encodedName.length + 1), depth + 1);
        if (!result.ok) return result;
      }
    }
    return ok(undefined);
  };

  const result = walk("/", folder.slice(1), 0);
  if (!result.ok) return result;
  const dir = matches[0];
  return ok(dir ? { dir, ambiguousWith: matches[1] ?? null, exhausted: budget.exhausted } : null);
}

/**
 * The directory to launch `claude --resume` from so it actually finds the session: the real
 * dir whose encoded realpath matches the file's storage folder. Returns Ok(dir) if found,
 * Ok(null) if absent (deleted/moved), or Err if the filesystem walk fails — distinguishing
 * unreadable from absent per ADR-0066. Caller must fail closed on Err.
 */
export function locateLaunchDir(filePath: string): Result<Located | null, Error> {
  return decodeStorageFolder(storageFolderOf(filePath));
}
