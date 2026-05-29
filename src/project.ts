import { existsSync } from "node:fs";
import { dirname, basename } from "node:path";

/** The grouping a Session belongs to. See CONTEXT.md: git repo root, cwd fallback. */
export interface Project {
  /** Absolute path used as the grouping key. */
  readonly root: string;
  /** Display name (basename of the root). */
  readonly name: string;
}

const cache = new Map<string, Project>();

/**
 * Derive a Session's Project from its `cwd`: the nearest ancestor containing `.git`,
 * else the `cwd` itself (when not in a repo, or the path no longer exists on disk).
 * Results are cached per `cwd`.
 */
export function deriveProject(cwd: string | null): Project {
  const key = cwd ?? "(unknown)";
  const cached = cache.get(key);
  if (cached) return cached;

  const project = resolve(cwd);
  cache.set(key, project);
  return project;
}

function resolve(cwd: string | null): Project {
  if (!cwd) return { root: "(unknown)", name: "(unknown)" };

  // Only walk if the directory actually exists; a moved/deleted path falls back to itself.
  if (existsSync(cwd)) {
    let dir = cwd;
    while (true) {
      if (existsSync(`${dir}/.git`)) return { root: dir, name: basename(dir) };
      const parent = dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  }
  return { root: cwd, name: basename(cwd) || cwd };
}

/** Test-only: clear the memoization cache. */
export function clearProjectCache(): void {
  cache.clear();
}
