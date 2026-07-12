import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Filesystem locations the tool owns. Everything here is RUNTIME/derived (session state +
 * rebuildable caches + UI prefs), so it lives under ~/.ccs (ADR-0049 — three homes, not four;
 * the old ~/.claude-sessions "fourth home" is retired). Honors $CCS_ROOT for test isolation,
 * matching inbox/identity-path.ccsRuntimeRoot (Bun's os.homedir ignores a reassigned $HOME).
 */
export function runtimeRoot(): string {
  const override = process.env.CCS_ROOT;
  if (override) return override;
  return join(process.env.HOME ?? homedir(), ".ccs");
}
/** The tool's own data dir under the runtime root. `cache/` holds the SQLite (state + caches). */
const DATA_DIR = () => join(runtimeRoot(), "cache");
export const CONFIG_PATH = () => join(runtimeRoot(), "config.toml");
export const DB_PATH = () => join(DATA_DIR(), "index.db");
/**
 * Catalogue: session metadata (rename, loop, lifecycle, tags). A SEPARATE file from the Index
 * on purpose — the Index is a pure cache dropped + rebuilt on schema bumps; the catalogue holds
 * session state that must survive that, so it never shares the file.
 */
export const CATALOGUE_PATH = () => join(DATA_DIR(), "catalogue.db");
/** Skills DB: machine-wide skill registry + usage cache (rebuildable) + user tags. */
export const SKILLS_DB_PATH = () => join(DATA_DIR(), "skills.db");
/** Small JSON of remembered UI prefs (e.g. last TUI view), so the browser reopens as left. */
export const PREFS_PATH = () => join(runtimeRoot(), "prefs.json");

/** Default Store: the single directory Claude Code centralises all Sessions into. */
export const DEFAULT_STORE_PATH = join(homedir(), ".claude", "projects");

/** Create the data dir lazily. Idempotent. */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR(), { recursive: true });
}

/** Expand a leading `~` to the home directory; pass other paths through. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
