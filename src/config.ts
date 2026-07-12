import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { CONFIG_PATH, DEFAULT_STORE_PATH, expandHome } from "./paths.ts";
import { type Result, ok, err } from "./result.ts";

/**
 * User config lives at ~/.ccs/config.toml (ADR-0049 — runtime home). Every key is optional;
 * defaults make the tool work with zero config. Validated at the boundary.
 */
const ConfigSchema = z.object({
  store: z
    .object({
      path: z.string().default(DEFAULT_STORE_PATH),
    })
    .prefault({}),
  host: z
    .object({
      label: z.string().default(hostname()),
    })
    .prefault({}),
  resume: z
    .object({
      target: z.enum(["auto", "cmux", "inline"]).default("auto"),
    })
    .prefault({}),
  /**
   * The LLM backend `ccs` uses for titling and the natural-language catalogue editor.
   * `engine` picks the backend: "auto" uses the first installed one (Codex preferred, then
   * Claude); "codex"/"claude" force it (falling back if that one isn't installed). The
   * `CCS_INFERENCE_ENGINE` env var and the in-TUI toggle both override this at runtime.
   */
  inference: z
    .object({
      engine: z.enum(["auto", "codex", "claude"]).default("auto"),
      codex: z
        .object({
          /** Codex executable; resolved on PATH. Bun.spawn ignores shell aliases. */
          binary: z.string().default("codex"),
          /** Empty = inherit the user's configured Codex default model (account-safe). */
          model: z.string().default(""),
          /** Codex reasoning effort; low is plenty and keeps it fast/cheap. */
          reasoningEffort: z.string().default("low"),
        })
        .prefault({}),
      claude: z
        .object({
          /** Claude Code executable; resolved on PATH. */
          binary: z.string().default("claude"),
          /** Model alias/name; "haiku" keeps background titling cheap. Empty = CLI default. */
          model: z.string().default("haiku"),
        })
        .prefault({}),
    })
    .prefault({}),
  titler: z
    .object({
      concurrency: z.number().int().positive().max(16).default(3),
      /** Give up titling a Session after this many failed attempts (across runs). */
      maxAttempts: z.number().int().positive().max(10).default(3),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

/** Load and validate config, applying defaults. `store.path` is `~`-expanded. */
export function loadConfig(path: string = CONFIG_PATH()): Result<Config> {
  let raw: unknown = {};
  try {
    const text = readFileSync(path, "utf8");
    raw = parseToml(text);
  } catch (e) {
    // Missing file → defaults. Any other read/parse error is surfaced.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return err(new Error(`Failed to read config at ${path}: ${(e as Error).message}`));
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return err(new Error(`Invalid config at ${path}:\n${z.prettifyError(parsed.error)}`));
  }

  const config = parsed.data;
  config.store.path = expandHome(config.store.path);
  return ok(config);
}
