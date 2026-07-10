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
  titler: z
    .object({
      /** Codex executable; resolved on PATH. Bun.spawn ignores shell aliases. */
      binary: z.string().default("codex"),
      /** Empty = inherit the user's configured Codex default model (account-safe). */
      model: z.string().default(""),
      /** Codex reasoning effort for titling; low is plenty and keeps it fast/cheap. */
      reasoningEffort: z.string().default("low"),
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
