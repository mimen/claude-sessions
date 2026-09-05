import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  CONFIG_PATH,
  DEFAULT_STORE_PATH,
  HOST_REGISTRY_PATH,
  LAUNCHER_REGISTRY_PATH,
  MODEL_REGISTRY_PATH,
  LOCATION_REGISTRY_PATH,
  expandHome,
} from "./paths.ts";
import { type Result, ok, err } from "./result.ts";

interface HostIdentityRuntime {
  readonly platform: NodeJS.Platform;
  readonly hostname: () => string;
  readonly execFileSync: (file: string, args: readonly string[]) => string;
}

const DEFAULT_HOST_IDENTITY_RUNTIME: HostIdentityRuntime = {
  platform: process.platform,
  hostname,
  execFileSync: (file, args) =>
    execFileSync(file, [...args], {
      encoding: "utf8",
      timeout: 3_000,
    }),
};

const darwinHostLabels = new WeakMap<HostIdentityRuntime, string>();

function resolveHostLabel(configuredLabel: string, runtime: HostIdentityRuntime): Result<string> {
  if (configuredLabel.trim()) return ok(configuredLabel);
  if (runtime.platform !== "darwin") return ok(runtime.hostname());
  const cached = darwinHostLabels.get(runtime);
  if (cached) return ok(cached);

  let output: string;
  try {
    output = runtime.execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"]);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`/usr/sbin/scutil --get LocalHostName failed: ${detail}`));
  }

  const localHostName = output.trim();
  if (!localHostName) {
    return err(new Error("/usr/sbin/scutil --get LocalHostName returned a blank value"));
  }
  darwinHostLabels.set(runtime, localHostName);
  return ok(localHostName);
}

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
      label: z.string().default(""),
    })
    .prefault({}),
  resume: z
    .object({
      target: z.enum(["auto", "cmux", "inline"]).default("auto"),
    })
    .prefault({}),
  routing: z
    .object({
      /** Shared, curated launch-location registry; empty resolves to the CCS runtime default. */
      registry: z.string().default(""),
      /** Shared canonical-host to SSH-alias registry; empty resolves to the CCS runtime default. */
      hosts: z.string().default(""),
      /**
       * Shared, VERSIONED launcher fleet; empty resolves to the CCS runtime default
       * (`~/.ccs/launchers.toml`, normally a link into the git-backed vault). Absent file → the
       * `[[launcher]]` entries below are the whole fleet, exactly as before.
       */
      launchers: z.string().default(""),
      /**
       * Shared model registry; empty resolves to the CCS runtime default
       * (`~/.ccs/models.toml`, normally a link into the git-backed vault).
       */
      models: z.string().default(""),
    })
    .prefault({}),
  /**
   * Claude Code launcher executables for cross-backend resume (`[[launcher]]` array tables).
   * Each entry names an executable and the model-id globs its backend can replay; sessions
   * route to launchers via src/resume/launchers.ts. Empty (the default) → plain `claude`.
   *
   * `env` is the SINGLE SOURCE of a launcher's environment: `ccs launcher install` materializes
   * it for the `~/.ccs/bin/claude` shim, and the resume/birth paths hand the same map to the
   * spawned process. A value of `@file:<path>` names a file whose first line is the value, so a
   * secret is referenced from config rather than copied into it. `clears` unsets inherited
   * variables before `env` is applied — how `claude-native` stays a true gateway escape hatch.
   */
  launcher: z
    .array(
      z.object({
        name: z.string().min(1),
        binary: z.string().min(1),
        serves: z.array(z.string().min(1)).default(["*"]),
        env: z.record(z.string(), z.string()).default({}),
        clears: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
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
export function loadConfig(
  path: string = CONFIG_PATH(),
  hostIdentityRuntime: HostIdentityRuntime = DEFAULT_HOST_IDENTITY_RUNTIME,
): Result<Config> {
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
  const hostLabel = resolveHostLabel(config.host.label, hostIdentityRuntime);
  if (!hostLabel.ok) return err(hostLabel.error);

  config.host.label = hostLabel.value;
  config.store.path = expandHome(config.store.path);
  config.routing.registry = config.routing.registry
    ? expandHome(config.routing.registry)
    : LOCATION_REGISTRY_PATH();
  config.routing.hosts = config.routing.hosts
    ? expandHome(config.routing.hosts)
    : HOST_REGISTRY_PATH();
  config.routing.launchers = config.routing.launchers
    ? expandHome(config.routing.launchers)
    : LAUNCHER_REGISTRY_PATH();
  config.routing.models = config.routing.models
    ? expandHome(config.routing.models)
    : MODEL_REGISTRY_PATH();
  return ok(config);
}
