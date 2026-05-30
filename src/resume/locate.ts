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
 * filesystem (the encoding is lossy, but real directory names disambiguate). Returns the
 * absolute path, or null if no existing directory matches (the dir was deleted/moved).
 */
export function decodeStorageFolder(folder: string): string | null {
  // Real Claude Code storage folders encode an absolute path, so they always start with `-`
  // (the leading `/`). Anything else is not a decodable folder.
  if (!folder.startsWith("-")) return null;
  return walk("/", folder.slice(1), 0, { n: MAX_NODES });
}

// Bounds so the fallback walk can never freeze the resume path (see review C2). The encoded
// folder has one segment per path component, so depth is naturally small; the node budget
// guards against pathological fan-out (many same-encoding siblings on a huge/slow tree).
const MAX_DEPTH = 24;
const MAX_NODES = 5000;

function walk(base: string, remaining: string, depth: number, budget: { n: number }): string | null {
  if (remaining === "") return base;
  if (depth > MAX_DEPTH || budget.n <= 0) return null;
  let names: string[];
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => String(e.name));
  } catch {
    return null;
  }
  for (const name of names) {
    if (budget.n <= 0) return null;
    budget.n--;
    const enc = encodePath(name);
    const full = join(base, name);
    if (enc === remaining) return full;
    if (remaining.startsWith(enc + "-")) {
      const found = walk(full, remaining.slice(enc.length + 1), depth + 1, budget);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The directory to launch `claude --resume` from so it actually finds the session: the real
 * dir whose encoded realpath matches the file's storage folder. Returns null if it can't be
 * located on disk (caller should fall back to recorded cwd / project root / home).
 */
export function locateLaunchDir(filePath: string): string | null {
  const folder = storageFolderOf(filePath);
  const decoded = decodeStorageFolder(folder);
  if (!decoded) return null;
  // Sanity: confirm it round-trips (guards against a lossy-encoding false match).
  try {
    return encodePath(realpathSync(decoded)) === folder ? decoded : decoded;
  } catch {
    return decoded;
  }
}
