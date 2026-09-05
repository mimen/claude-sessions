/**
 * The surfaces `ccs launcher install` GENERATES from the model registry.
 *
 * Four clients learn about models from an explicit list rather than from gateway discovery, and
 * before this every one of them was hand-maintained: Claude Code's per-launcher allowlist and
 * `/model` rows, the launcher's tier-slot environment, opencode's model map, and T3 Code's custom
 * model list. Each is rewritten in place from the registry, and each rewrite is idempotent, so the
 * playbook's last step is running this rather than rereading five files.
 *
 * Every rewrite here PRESERVES what it does not own. opencode and T3 files carry a great deal of
 * unrelated user configuration, so the transforms replace exactly one key and re-serialize the
 * rest verbatim.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import {
  allowlist,
  claudeCodeDeclaration,
  familyOf,
  labelOf,
  pickerRows,
  slots,
  SLOT_ENVIRONMENT_KEYS,
  type LauncherSlots,
  type ModelRegistry,
} from "../models/registry.ts";

/** Context ceiling opencode is told for a retired model whose row records no window. */
const HISTORICAL_WINDOW_FALLBACK = 200_000;
/** Every gateway lane accepts this much output; opencode requires the field. */
const OPENCODE_OUTPUT_LIMIT = 128_000;

export function launcherSettingsFilename(launcher: string): string {
  return `${launcher}.settings.json`;
}

/**
 * One launcher's Claude Code settings: the models it hosts, and the `/model` rows it offers.
 *
 * Null when the registry gives the launcher no rows at all: an empty `availableModels` would
 * leave Claude Code unable to resolve any model, which is worse than letting the shared
 * settings.json stand.
 */
export function launcherSettingsContents(
  registry: ModelRegistry,
  launcher: string,
): string | null {
  const models = allowlist(registry, launcher);
  if (models.length === 0) return null;
  const settings = {
    availableModels: models,
    modelPicker: {
      replaceBuiltInOptions: true,
      options: pickerRows(registry, launcher),
    },
  };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * A launcher's tier slots as Claude Code environment assignments.
 *
 * Model-bearing slots run through `claudeCodeDeclaration`, so a Claude id gains its family marker
 * and a GPT id never does, the same derivation the picker rows use, from the same rows.
 */
export function slotEnvironment(
  registry: ModelRegistry,
  launcher: string,
): Readonly<Record<string, string>> {
  const table = slots(registry, launcher);
  if (!table) return {};
  const environment: Record<string, string> = {};
  for (const [slot, key] of Object.entries(SLOT_ENVIRONMENT_KEYS)) {
    const value = table[slot as keyof LauncherSlots];
    if (value === undefined) continue;
    environment[key] = typeof value === "number"
      ? String(value)
      : claudeCodeDeclaration(registry, value, launcher);
  }
  return environment;
}

/** Strip whole-line `//` comments so a jsonc file parses; block comments are not used here. */
function stripLineComments(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const OpencodeSchema = z.object({
  provider: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
}).passthrough();

interface OpencodeModelEntry {
  readonly name: string;
  readonly limit: { readonly context: number; readonly output: number };
}

/** Every registry model opencode should offer, keyed by canonical id, active rows first. */
export function opencodeModelMap(registry: ModelRegistry): Readonly<Record<string, OpencodeModelEntry>> {
  const models: Record<string, OpencodeModelEntry> = {};
  for (const model of registry.model) {
    const window = familyOf(registry, model.id)?.window ?? HISTORICAL_WINDOW_FALLBACK;
    models[model.id] = { name: model.label, limit: { context: window, output: OPENCODE_OUTPUT_LIMIT } };
  }
  for (const row of registry.historical) {
    models[row.id] = {
      name: row.label ?? labelOf(registry, row.id) ?? row.id,
      limit: { context: row.window ?? HISTORICAL_WINDOW_FALLBACK, output: OPENCODE_OUTPUT_LIMIT },
    };
  }
  return models;
}

/**
 * Rewrite only `provider.cliproxyapi.models`. Null means the file declares no cliproxyapi
 * provider, which is a configuration this generator has no business inventing.
 */
export function renderOpencodeConfig(text: string, registry: ModelRegistry): Result<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripLineComments(text));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`opencode config is not parseable JSON once comments are stripped: ${detail}`));
  }
  const parsed = OpencodeSchema.safeParse(raw);
  if (!parsed.success) return err(new Error(`unexpected opencode config shape: ${z.prettifyError(parsed.error)}`));
  const provider = parsed.data.provider?.["cliproxyapi"];
  if (!provider) return ok(null);
  const next = {
    ...(raw as Record<string, unknown>),
    provider: {
      ...parsed.data.provider,
      cliproxyapi: { ...provider, models: opencodeModelMap(registry) },
    },
  };
  return ok(`${JSON.stringify(next, null, 2)}\n`);
}

const T3SettingsSchema = z.object({
  providerInstances: z.record(z.string(), z.object({
    config: z.record(z.string(), z.unknown()).optional(),
  }).passthrough()).optional(),
}).passthrough();

/**
 * T3 Code already knows every Anthropic id from its own manifest, so `customModels` carries only
 * the gateway ids it would otherwise never offer.
 */
export function renderT3Settings(text: string, registry: ModelRegistry): Result<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`T3 settings is not parseable JSON: ${detail}`));
  }
  const parsed = T3SettingsSchema.safeParse(raw);
  if (!parsed.success) return err(new Error(`unexpected T3 settings shape: ${z.prettifyError(parsed.error)}`));
  const instance = parsed.data.providerInstances?.["claudeAgent"];
  if (!instance) return ok(null);
  const customModels = registry.model
    .map((model) => model.id)
    .filter((id) => !id.startsWith("claude-"));
  const next = {
    ...(raw as Record<string, unknown>),
    providerInstances: {
      ...parsed.data.providerInstances,
      claudeAgent: { ...instance, config: { ...(instance.config ?? {}), customModels } },
    },
  };
  return ok(`${JSON.stringify(next, null, 2)}\n`);
}

const T3ClientSchema = z.object({
  providerModelPreferences: z.record(z.string(), z.object({
    modelOrder: z.array(z.string()).optional(),
  }).passthrough()).optional(),
}).passthrough();

/** Registry order leads T3's picker; ids a human added by hand keep their place after it. */
export function renderT3ClientSettings(text: string, registry: ModelRegistry): Result<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`T3 client settings is not parseable JSON: ${detail}`));
  }
  const parsed = T3ClientSchema.safeParse(raw);
  if (!parsed.success) return err(new Error(`unexpected T3 client settings shape: ${z.prettifyError(parsed.error)}`));
  const preferences = parsed.data.providerModelPreferences?.["claudeAgent"];
  if (!preferences) return ok(null);
  const registryOrder = registry.model.map((model) => model.id);
  const extras = (preferences.modelOrder ?? []).filter((id) => !registryOrder.includes(id));
  const next = {
    ...(raw as Record<string, unknown>),
    providerModelPreferences: {
      ...parsed.data.providerModelPreferences,
      claudeAgent: { ...preferences, modelOrder: [...registryOrder, ...extras] },
    },
  };
  return ok(`${JSON.stringify(next, null, 2)}\n`);
}

export interface ClientSurfacePaths {
  readonly opencodeConfig: string;
  readonly t3Settings: string;
  readonly t3ClientSettings: string;
}

export interface ClientSurfaceResult {
  /** Files rewritten, in the order they were written. */
  readonly written: readonly string[];
  /** Why a file was skipped. A machine without T3 is a normal state, not a failure. */
  readonly warnings: readonly string[];
}

type Transform = (text: string, registry: ModelRegistry) => Result<string | null>;

function rewriteFile(
  path: string,
  transform: Transform,
  registry: ModelRegistry,
  missingKeyWarning: string,
  result: { written: string[]; warnings: string[] },
): Result<void> {
  if (!existsSync(path)) {
    result.warnings.push(`skipped ${path}: no such file on this machine`);
    return ok(undefined);
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  const rendered = transform(text, registry);
  if (!rendered.ok) return rendered;
  if (rendered.value === null) {
    result.warnings.push(`skipped ${path}: ${missingKeyWarning}`);
    return ok(undefined);
  }
  // Rewriting an unchanged file would churn its mtime on every install for no reason.
  if (rendered.value === text) return ok(undefined);
  try {
    atomicWriteFile(path, rendered.value, 0o600);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  result.written.push(path);
  return ok(undefined);
}

/** Bring the non-Claude-Code clients into step with the registry. Idempotent. */
export function writeClientSurfaces(
  registry: ModelRegistry,
  paths: ClientSurfacePaths,
): Result<ClientSurfaceResult> {
  const result = { written: [] as string[], warnings: [] as string[] };
  const steps: readonly [string, Transform, string][] = [
    [paths.opencodeConfig, renderOpencodeConfig, "it declares no provider.cliproxyapi"],
    [paths.t3Settings, renderT3Settings, "it declares no claudeAgent provider instance"],
    [paths.t3ClientSettings, renderT3ClientSettings, "it declares no claudeAgent model preferences"],
  ];
  for (const [path, transform, warning] of steps) {
    const written = rewriteFile(path, transform, registry, warning, result);
    if (!written.ok) return written;
  }
  return ok(result);
}
