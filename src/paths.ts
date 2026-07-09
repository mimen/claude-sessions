import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Filesystem locations the tool owns. The data dir holds the config file and the
 * Index (a pure, rebuildable cache); see CONTEXT.md.
 */
export const DATA_DIR = join(homedir(), ".claude-sessions");
export const CONFIG_PATH = join(DATA_DIR, "config.toml");
export const DB_PATH = join(DATA_DIR, "index.db");
/**
 * Catalogue: durable user-authored session metadata (rename, loop, lifecycle, tags).
 * A SEPARATE file from the Index on purpose — the Index is a pure cache that gets dropped
 * and rebuilt on schema bumps; the catalogue must survive that, so it never shares the file.
 */
export const CATALOGUE_PATH = join(DATA_DIR, "catalogue.db");
/**
 * Skills DB: machine-wide skill registry + transcript usage cache (rebuildable),
 * plus durable user-authored tags. Separate file so Index schema bumps never touch it.
 */
export const SKILLS_DB_PATH = join(DATA_DIR, "skills.db");
/**
 * The Merged View (issue 33): the fleet-wide catalogue, BUILT on the always-on Host from every
 * Host's data dir, PULLED here on the others. Purely derived and rebuildable — deletable
 * without loss, like the Index; never synced, never in the vault.
 */
export const MERGE_PATH = join(DATA_DIR, "merge.db");

/** Default Store: the single directory Claude Code centralises all Sessions into. */
export const DEFAULT_STORE_PATH = join(homedir(), ".claude", "projects");

/** Create the data dir lazily. Idempotent. */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
}

/** Expand a leading `~` to the home directory; pass other paths through. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
