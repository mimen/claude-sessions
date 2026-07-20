/**
 * Launchers + routes (cross-backend resume). A LAUNCHER is one Claude Code executable
 * (native `claude`, a gateway wrapper like `claude-gpt`, …) declared in config.toml with the
 * model-id globs its backend can replay. A ROUTE is one launcher's eligibility verdict for a
 * given session's model history. Transcripts are stored in Anthropic format regardless of
 * backend, but only a backend that can replay EVERY model in the history may resume it —
 * e.g. Claude-native thinking signatures don't survive a GPT gateway.
 */
import { loadConfig } from "../config.ts";
import { type Result, ok, err } from "../result.ts";

export interface Launcher {
  /** Config key for `--via` and display. */
  readonly name: string;
  /** argv[0] — an executable name resolved on PATH, or an absolute path. */
  readonly binary: string;
  /** Model-id globs this backend can replay ("*" = anything). */
  readonly serves: readonly string[];
  /** Extra env for the spawned process (lets a launcher be `claude` + env vars). */
  readonly env: Readonly<Record<string, string>>;
}

export interface Route {
  readonly launcher: Launcher;
  readonly eligible: boolean;
  /** Human-readable ineligibility reason; null when eligible. */
  readonly reason: string | null;
}

/** Behavior with no `[[launcher]]` config: exactly today's hardcoded `claude`. */
export const DEFAULT_LAUNCHERS: readonly Launcher[] = [
  { name: "claude", binary: "claude", serves: ["*"], env: {} },
];

/** Shape of one `[[launcher]]` config entry (validated by the config schema). */
export interface LauncherConfigEntry {
  readonly name: string;
  readonly binary: string;
  readonly serves: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Config entries → launchers. Empty list → DEFAULT_LAUNCHERS (feature invisible until
 * configured). Duplicate names are a config error — `--via` would be ambiguous.
 */
export function launchersFrom(entries: readonly LauncherConfigEntry[]): Launcher[] | { error: string } {
  if (entries.length === 0) return [...DEFAULT_LAUNCHERS];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.name)) return { error: `duplicate launcher name "${e.name}" in config` };
    seen.add(e.name);
  }
  return entries.map((e) => ({ name: e.name, binary: e.binary, serves: e.serves, env: e.env }));
}

/**
 * Match a model id against a serves glob. Only `*` is special (any run of chars); everything
 * else is literal — deliberately NOT user-string→regex.
 */
export function matchesModel(pattern: string, modelId: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === modelId;
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === "") continue;
    const at = modelId.indexOf(part, pos);
    if (at === -1) return false;
    // Anchor the first segment at the start and the last at the end.
    if (i === 0 && at !== 0) return false;
    pos = at + part.length;
  }
  const last = parts[parts.length - 1]!;
  if (last !== "" && !modelId.endsWith(last)) return false;
  return true;
}

/** Non-wildcard character count — how specific a glob is ("gpt-*" = 4, "*" = 0). */
function literalLength(pattern: string): number {
  return pattern.replaceAll("*", "").length;
}

/**
 * Verdict per launcher, in config order. Eligible iff EVERY model in the session's history
 * matches at least one of the launcher's serves globs. An empty model set (no assistant
 * turns yet) is eligible everywhere.
 */
export function resolveRoutes(launchers: readonly Launcher[], models: readonly string[]): Route[] {
  return launchers.map((launcher) => {
    const unmatched = models.filter((m) => !launcher.serves.some((p) => matchesModel(p, m)));
    if (unmatched.length === 0) return { launcher, eligible: true, reason: null };
    return {
      launcher,
      eligible: false,
      reason: `history contains ${unmatched.join(", ")}, not matched by serves=[${launcher.serves.join(", ")}]`,
    };
  });
}

/**
 * Default route = ORIGIN-BACKEND preference: among eligible routes, the launcher whose serves
 * globs match the history most specifically wins (so a pure-gpt session defaults to the gpt
 * launcher over catch-all native; mixed histories only match "*" launchers → native). Score =
 * the weakest model's best matching-glob specificity; tie → config order. Null only when no
 * route is eligible (a config without a catch-all launcher).
 */
export function defaultRoute(routes: readonly Route[], models: readonly string[]): Route | null {
  let best: Route | null = null;
  let bestScore = -1;
  for (const route of routes) {
    if (!route.eligible) continue;
    let score = Number.MAX_SAFE_INTEGER;
    for (const m of models) {
      let perModel = -1;
      for (const p of route.launcher.serves) {
        if (matchesModel(p, m)) perModel = Math.max(perModel, literalLength(p));
      }
      score = Math.min(score, perModel);
    }
    if (models.length === 0) score = 0;
    if (score > bestScore) {
      bestScore = score;
      best = route;
    }
  }
  return best;
}

export function launcherByName(launchers: readonly Launcher[], name: string): Launcher | null {
  return launchers.find((l) => l.name === name) ?? null;
}

/** Load the launcher fleet from config.toml. Config errors stay LOUD (a silent fall-back to
 * plain `claude` would resume a gpt session on the wrong sub). */
export function loadLaunchers(): Result<Launcher[]> {
  const cfg = loadConfig();
  if (!cfg.ok) return cfg;
  const launchers = launchersFrom(cfg.value.launcher);
  if ("error" in launchers) return err(new Error(launchers.error));
  return ok(launchers);
}
