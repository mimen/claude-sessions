import { readdirSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";

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

// Bounds so the fallback walk can never freeze the resume path (see review C2). The encoded
// folder has one segment per path component, so depth is naturally small; the node budget
// guards against pathological fan-out (many same-encoding siblings on a huge/slow tree).
const MAX_DEPTH = 24;
const MAX_NODES = 5000;
const MAX_MATCHES = 2; // two is enough to know the encoding is ambiguous

/**
 * Resolve a storage folder back to the real directory that encodes to it, by walking the
 * filesystem. Every candidate is verified through encodesTo(); the search continues past a
 * failed candidate and keeps going after the first hit so ambiguity is DETECTED, not silently
 * resolved by readdir order. Null when no existing directory matches (deleted/moved).
 */
export function decodeStorageFolder(folder: string): Located | null {
  // Real Claude Code storage folders encode an absolute path, so they always start with `-`
  // (the leading `/`). Anything else is not a decodable folder.
  if (!folder.startsWith("-")) return null;
  // The root dir itself ("/" → "-") has no parent to walk from; answer it directly.
  if (folder === "-") {
    return encodesTo("/", folder) ? { dir: "/", ambiguousWith: null, exhausted: false } : null;
  }

  const matches: string[] = [];
  const budget = { nodes: MAX_NODES, exhausted: false };

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
        .map((e) => String(e.name));
    } catch {
      return;
    }
    for (const name of names) {
      if (matches.length >= MAX_MATCHES) return;
      if (budget.nodes <= 0) {
        budget.exhausted = true;
        return;
      }
      budget.nodes--;
      const enc = encodePath(name);
      const full = join(base, name);
      if (enc === remaining) {
        if (encodesTo(full, folder)) matches.push(full);
        // A failed backstop check is not the end — keep scanning siblings/prefix splits.
      } else if (remaining.startsWith(enc + "-")) {
        walk(full, remaining.slice(enc.length + 1), depth + 1);
      }
    }
  };

  walk("/", folder.slice(1), 0);
  const dir = matches[0];
  if (!dir) return null;
  return { dir, ambiguousWith: matches[1] ?? null, exhausted: budget.exhausted };
}

/**
 * The directory to launch `claude --resume` from so it actually finds the session: the real
 * dir whose encoded realpath matches the file's storage folder. Returns null if it can't be
 * located on disk (caller should fall back to recorded cwd / project root / home).
 */
export function locateLaunchDir(filePath: string): Located | null {
  return decodeStorageFolder(storageFolderOf(filePath));
}
