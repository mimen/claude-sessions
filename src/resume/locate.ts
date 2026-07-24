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
 *
 * The encoding is lossy (`/a-b` and `/a/b` both encode to `-a-b`). The walk verifies every
 * candidate via `encodesTo()` (round-trip) and CONTINUES past a false match, collecting up to
 * two verified hits so ambiguity is DETECTED, not silently resolved by readdir order.
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

/**
 * Whether launching claude in `dir` surfaces sessions stored under `folder`: claude derives
 * the folder from encode(realpath(cwd)). If realpath errors (transient fs hiccup), fall back
 * to the literal path — walk candidates are joined from real dirent names, so their literal
 * encoding matches by construction.
 */
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

// Bounds so the fallback walk can never freeze the resume path. The encoded folder has one
// segment per path component, so depth is naturally small; the node budget guards against
// pathological fan-out (many same-encoding siblings on a huge/slow tree).
const MAX_DEPTH = 24;
const MAX_NODES = 5000;
const MAX_MATCHES = 2; // two is enough to know the encoding is ambiguous

interface Budget {
  nodes: number;
  exhausted: boolean;
}

/**
 * Resolve a storage folder back to the real directory that encodes to it, by walking the
 * filesystem. Every candidate is verified through encodesTo(); the search continues past a
 * failed candidate and keeps going after the first hit so ambiguity is DETECTED, not silently
 * resolved by readdir order.
 *
 * Returns Ok(Located) on ≥1 verified match, Ok(null) when no directory matches
 * (deleted/moved), or Err on a hard filesystem error at the walk root (permission at `/`,
 * I/O failure) — distinguishing unreadable from absent per ADR-0066. Directory-level
 * readdir failures deeper in the walk are logged and skipped: a single unreadable subtree
 * doesn't invalidate the whole answer, and if a hit was already found we still return it.
 */
export function decodeStorageFolder(folder: string): Result<Located | null, Error> {
  // Real Claude Code storage folders encode an absolute path, so they always start with `-`
  // (the leading `/`). Anything else is not a decodable folder.
  if (!folder.startsWith("-")) return ok(null);
  // The root dir itself ("/" → "-") has no parent to walk from; answer it directly.
  if (folder === "-") {
    return ok(encodesTo("/", folder) ? { dir: "/", ambiguousWith: null, exhausted: false } : null);
  }

  const matches: string[] = [];
  const budget: Budget = { nodes: MAX_NODES, exhausted: false };
  let rootError: Error | null = null;

  const walk = (base: string, remaining: string, depth: number): void => {
    if (matches.length >= MAX_MATCHES) return;
    if (depth > MAX_DEPTH || budget.nodes <= 0) {
      budget.exhausted = true; // gave up with work left — a further match can't be ruled out
      return;
    }
    let names: string[];
    try {
      names = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory()) // symlinks report false here — see header
        .map((e) => String(e.name))
        .sort();
    } catch (error) {
      // At the walk root, a readdir failure means we can't even start — fail closed.
      if (depth === 0) {
        rootError = error instanceof Error ? error : new Error(String(error));
        log.error("Failed to read root during storage folder walk", {
          base,
          error: rootError.message,
        });
      } else {
        // Deeper failures (permission on a subtree, transient I/O) are logged and skipped;
        // the walk continues elsewhere. If ambiguity happens to live under this subtree,
        // we may miss it, but we've never let a bad ambiguous silently win.
        log.warn("Failed to read subtree during storage folder walk (skipping)", {
          base,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    for (const name of names) {
      if (matches.length >= MAX_MATCHES) return;
      const enc = encodePath(name);
      const exact = enc === remaining;
      const prefix = remaining.startsWith(enc + "-");
      // readdir already paid the cost of inspecting this directory. Spend the bounded node
      // budget only on encoding-compatible branches; irrelevant siblings cannot hide a valid
      // target merely because a shared temp/cache directory contains thousands of entries.
      if (!exact && !prefix) continue;
      if (budget.nodes <= 0) {
        budget.exhausted = true;
        return;
      }
      budget.nodes--;
      const full = join(base, name);
      if (exact) {
        // A failed backstop check is not the end — keep scanning siblings/prefix splits.
        if (encodesTo(full, folder)) matches.push(full);
      } else {
        walk(full, remaining.slice(enc.length + 1), depth + 1);
      }
    }
  };

  walk("/", folder.slice(1), 0);
  if (rootError) return err(rootError);

  const dir = matches[0];
  if (!dir) return ok(null);
  return ok({ dir, ambiguousWith: matches[1] ?? null, exhausted: budget.exhausted });
}

/**
 * The directory to launch `claude --resume` from so it actually finds the session: the real
 * dir whose encoded realpath matches the file's storage folder. Returns Ok(Located) with the
 * dir + ambiguity signals, Ok(null) if absent (deleted/moved), or Err on a hard filesystem
 * error (fail closed per ADR-0066).
 */
export function locateLaunchDir(filePath: string): Result<Located | null, Error> {
  return decodeStorageFolder(storageFolderOf(filePath));
}
