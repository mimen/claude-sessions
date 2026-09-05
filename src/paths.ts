import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync } from "node:fs";

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
/** Validated launch-location registry, normally a machine-adapter-managed link to shared config. */
export const LOCATION_REGISTRY_PATH = () => join(runtimeRoot(), "locations.toml");
/** Canonical life-domain registry. Tests and nonstandard vaults may set an explicit override. */
export const CATEGORY_REGISTRY_PATH = () =>
  process.env.CCS_CATEGORY_REGISTRY_PATH
  ?? join(process.env.HOME ?? homedir(), "Documents", "milad-vault", "ClaudeConfig", "categories", "registry.json");
/** Validated remote-host registry, normally a machine-adapter-managed link to shared config. */
export const HOST_REGISTRY_PATH = () => join(runtimeRoot(), "hosts.toml");
/**
 * Shared launcher fleet, normally a link to the git-backed vault copy. Machine-local
 * `[[launcher]]` entries in config.toml still override it by name, so a host keeps its own facts
 * (a binary that is not installed here) while the canonical fleet stays versioned and backed up.
 */
export const LAUNCHER_REGISTRY_PATH = () => join(runtimeRoot(), "launchers.toml");
/**
 * Shared model registry, normally a link to the git-backed vault copy. It is the only place a
 * model's id, family, context window, launcher membership, label, colour, price and birth
 * eligibility are written; ccs reads it, `ccs launcher install` generates from it, and
 * `ccs doctor models` refuses anything that disagrees with it.
 */
export const MODEL_REGISTRY_PATH = () => join(runtimeRoot(), "models.toml");
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

/** Runtime-only ownership files for the on-demand native-session catalogue daemon. */
const RUN_DIR = () => join(runtimeRoot(), "run");
function defaultCatalogueSocketPath(): string {
  const preferred = join(RUN_DIR(), "native-catalogue-v1.sock");
  // macOS sockaddr_un.sun_path is only 104 bytes. Keep the fallback in a private per-user
  // directory rather than directly in the shared temp root: socket modes are not a reliable
  // access boundary on every Unix platform.
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const digest = createHash("sha256").update(runtimeRoot()).digest("hex").slice(0, 16);
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(tmpdir(), `ccs-${uid}-${digest}`, "native-catalogue-v1.sock");
}
export const CATALOGUE_SERVICE_SOCKET_PATH = () =>
  process.env.CCS_CATALOGUE_SOCKET ?? defaultCatalogueSocketPath();
export const CATALOGUE_SERVICE_LOCK_PATH = () => join(RUN_DIR(), "native-catalogue.lock");
export const CATALOGUE_SERVICE_LOG_PATH = () => join(RUN_DIR(), "native-catalogue.log");

/** Default Store: the single directory Claude Code centralises all Sessions into. */
export const DEFAULT_STORE_PATH = join(homedir(), ".claude", "projects");

/**
 * Claude Code's per-session task lists (TaskCreate/TaskUpdate tool state): one dir per
 * session UUID holding N.json files. A sibling of the Store, owned by Claude Code — we
 * only ever read it.
 */
export const DEFAULT_TASKS_PATH = join(homedir(), ".claude", "tasks");

/** Create the data dir lazily. Idempotent. */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR(), { recursive: true });
}

/** Create the daemon run directory as user-private host-local state. */
export function ensureRunDir(): void {
  const path = RUN_DIR();
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  const socketParent = dirname(defaultCatalogueSocketPath());
  if (socketParent !== path) {
    mkdirSync(socketParent, { recursive: true, mode: 0o700 });
    chmodSync(socketParent, 0o700);
  }
}

/** Expand a leading `~` to the home directory; pass other paths through. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}
