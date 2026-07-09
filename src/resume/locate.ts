import { readdirSync, realpathSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/**
 * Claude Code stores a session at `~/.claude/projects/<folder>/<id>.jsonl`, where
 * `<folder> = encode(realpath(cwd_at_creation))` and `encode` maps every non-alphanumeric
 * char to `-`. On resume it looks under `encode(realpath(current_dir))`. So a session is
 * resumable only from the directory whose encoded realpath equals its storage folder — which
 * is NOT always the recorded `cwd` (it drifts when a symlinked cwd is later changed/removed,
 * the "No conversation found" bug). The storage folder is therefore authoritative.
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
 * filesystem. Every candidate is round-trip verified — `encode(realpath(candidate))` must equal
 * the folder — because claude only finds the session from a dir whose encoded REALPATH matches:
 * a symlink whose target encodes differently is a false match the lossy encoding can't see.
 * Returns the first verified match, or null if none exists (the dir was deleted/moved).
 */
export function decodeStorageFolder(folder: string): string | null {
  return decodeStorageFolderAll(folder)[0] ?? null;
}

/**
 * All round-trip-verified matches for a storage folder, capped at MAX_MATCHES — two is enough
 * to know the encoding is ambiguous (`/a-b` vs `/a/b`), which the caller should surface rather
 * than silently resuming in whichever the walk met first.
 */
export function decodeStorageFolderAll(folder: string): string[] {
  // Real Claude Code storage folders encode an absolute path, so they always start with `-`
  // (the leading `/`). Anything else is not a decodable folder.
  if (!folder.startsWith("-")) return [];
  const matches: string[] = [];
  walk("/", folder.slice(1), 0, { n: MAX_NODES }, folder, matches);
  return matches;
}

// Bounds so the fallback walk can never freeze the resume path (see review C2). The encoded
// folder has one segment per path component, so depth is naturally small; the node budget
// guards against pathological fan-out (many same-encoding siblings on a huge/slow tree).
const MAX_DEPTH = 24;
const MAX_NODES = 5000;
const MAX_MATCHES = 2;

/** Whether launching claude in this dir would actually surface the session (realpath check). */
function roundTrips(dir: string, folder: string): boolean {
  try {
    return encodePath(realpathSync(dir)) === folder;
  } catch {
    return false;
  }
}

function walk(
  base: string,
  remaining: string,
  depth: number,
  budget: { n: number },
  folder: string,
  matches: string[],
): void {
  if (depth > MAX_DEPTH || budget.n <= 0 || matches.length >= MAX_MATCHES) return;
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name));
  } catch {
    return;
  }
  for (const name of names) {
    if (budget.n <= 0 || matches.length >= MAX_MATCHES) return;
    budget.n--;
    const enc = encodePath(name);
    const full = join(base, name);
    if (enc === remaining) {
      // A false match (symlink to elsewhere) is rejected and the search CONTINUES — the real
      // dir may be a later sibling or live down a different prefix split.
      if (roundTrips(full, folder)) matches.push(full);
    } else if (remaining.startsWith(enc + "-")) {
      walk(full, remaining.slice(enc.length + 1), depth + 1, budget, folder, matches);
    }
  }
}

/**
 * The directory to launch `claude --resume` from so it actually finds the session: the real
 * dir whose encoded realpath matches the file's storage folder. Returns null if it can't be
 * located on disk (caller should fall back to recorded cwd / project root / home).
 */
export function locateLaunchDir(filePath: string): string | null {
  return locateLaunchDirs(filePath)[0] ?? null;
}

/** All verified launch dirs for a session file (≥2 means the lossy encoding is ambiguous). */
export function locateLaunchDirs(filePath: string): string[] {
  return decodeStorageFolderAll(storageFolderOf(filePath));
}
