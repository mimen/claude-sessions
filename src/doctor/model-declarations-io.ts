import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Config, loadConfig } from "../config.ts";
import { loadLocationRegistry } from "../locations/registry.ts";
import { CONFIG_PATH } from "../paths.ts";
import { err, ok, type Result } from "../result.ts";
import { type Launcher, effectiveLaunchers } from "../resume/launchers.ts";
import {
  buildModelDeclarationsReport,
  type LauncherServes,
  type ModelBehaviorMapping,
  type ModelDeclaration,
  type ModelDeclarationsReport,
  type ModelMembershipRequirement,
  type ModelPickerRow,
  type PolicyModelReference,
} from "./model-declarations.ts";
import { loadModelRegistry, type ModelRegistry } from "../models/registry.ts";

const SettingsSchema = z.object({
  model: z.string().optional(),
  availableModels: z.array(z.string()).optional(),
  modelPicker: z.object({
    options: z.array(z.object({
      model: z.string(),
      behavesAs: z.string().optional(),
    }).passthrough()),
  }).passthrough().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).passthrough();

const AgentModelSchema = z.object({
  model: z.string().optional(),
  fallback_model: z.string().optional(),
}).passthrough();

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const DEFAULT_MODEL_ENVIRONMENT_KEY = /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/;
const MODEL_ENVIRONMENT_KEYS = new Set([
  "ANTHROPIC_CUSTOM_MODEL_OPTION",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_AUTO_MODE_MODEL",
  "CLAUDE_CODE_BG_CLASSIFIER_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
]);

export interface ModelDeclarationsOptions {
  readonly settingsPath?: string;
  readonly agentsRoot?: string;
  readonly configPath?: string;
  readonly launcherRegistryPath?: string;
  readonly locationRegistryPath?: string;
  readonly modelRegistryPath?: string;
  readonly hermesConfigPath?: string;
  readonly pstackModelsPath?: string;
  readonly gatewayKeyPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Injected by tests; production probes the live gateway catalogue. */
  readonly fetchGatewayModels?: (registry: ModelRegistry) => Promise<readonly string[] | null>;
}

const HermesSchema = z.object({
  model: z.object({ default: z.string().optional() }).passthrough().optional(),
  providers: z.record(z.string(), z.object({
    default_model: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const PstackSchema = z.object({
  singleRoleDefault: z.string().optional(),
  panel: z.array(z.string()).optional(),
  available: z.array(z.object({ slug: z.string() }).passthrough()).optional(),
  roles: z.array(z.object({ role: z.string(), models: z.array(z.string()) }).passthrough()).optional(),
}).passthrough();

/** Model ids Hermes selects by hand; its catalogue itself is discovered live from the gateway. */
function readHermes(path: string): readonly PolicyModelReference[] {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch {
    // A machine without Hermes has nothing to check, and a malformed Hermes config is Hermes's
    // own doctor to report.
    return [];
  }
  const config = HermesSchema.safeParse(parsed);
  if (!config.success) return [];
  const references: PolicyModelReference[] = [];
  if (config.data.model?.default) {
    references.push({ path, field: "model.default", value: config.data.model.default });
  }
  for (const [name, provider] of Object.entries(config.data.providers ?? {})) {
    if (provider.default_model) {
      references.push({ path, field: `providers.${name}.default_model`, value: provider.default_model });
    }
  }
  return references;
}

/** Role defaults pstack stamps into its skills. Out of scope for generation, in scope for drift. */
function readPstackModels(path: string): readonly PolicyModelReference[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const models = PstackSchema.safeParse(parsed);
  if (!models.success) return [];
  const references: PolicyModelReference[] = [];
  const add = (field: string, value: string): void => {
    references.push({ path, field, value });
  };
  if (models.data.singleRoleDefault) add("singleRoleDefault", models.data.singleRoleDefault);
  for (const [index, value] of (models.data.panel ?? []).entries()) add(`panel[${index}]`, value);
  for (const [index, entry] of (models.data.available ?? []).entries()) add(`available[${index}].slug`, entry.slug);
  for (const entry of models.data.roles ?? []) {
    for (const [index, value] of entry.models.entries()) add(`roles[${entry.role}].models[${index}]`, value);
  }
  return references;
}

const GatewayModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() }).passthrough()),
});

/**
 * The gateway's live catalogue. Null on any transport or shape failure: an unreachable gateway is
 * a fact about right now, not drift in the registry, so it warns rather than fails.
 */
async function probeGatewayModels(
  registry: ModelRegistry,
  keyPath: string,
): Promise<readonly string[] | null> {
  if (!registry.gateway) return null;
  let key: string;
  try {
    key = readFileSync(keyPath, "utf8").trim();
  } catch {
    return null;
  }
  try {
    const response = await fetch(`${registry.gateway}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const parsed = GatewayModelsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.data.map((model) => model.id) : null;
  } catch {
    return null;
  }
}

function direct(
  declarations: ModelDeclaration[],
  path: string,
  field: string,
  surface: ModelDeclaration["surface"],
  value: string,
): void {
  declarations.push({ path, field, surface, mode: "direct", value });
}

function canonical(
  declarations: ModelDeclaration[],
  path: string,
  field: string,
  value: string,
): void {
  declarations.push({ path, field, surface: "routing.default_model", mode: "canonical", value });
}

function modelEnvironmentSurface(
  key: string,
  scope: "settings" | "launcher",
): ModelDeclaration["surface"] | null {
  if (key === "CLAUDE_CODE_SUBAGENT_MODEL") {
    return scope === "settings" ? "settings.subagentModel" : "launcher.environment";
  }
  if (DEFAULT_MODEL_ENVIRONMENT_KEY.test(key)) {
    return scope === "settings" ? "settings.environment" : "launcher.slot";
  }
  if (MODEL_ENVIRONMENT_KEYS.has(key)) {
    return scope === "settings" ? "settings.environment" : "launcher.environment";
  }
  return null;
}

function readSettings(
  path: string,
  declarations: ModelDeclaration[],
  memberships: ModelMembershipRequirement[],
  behaviorMappings: ModelBehaviorMapping[],
  pickerRows: ModelPickerRow[],
): Result<void> {
  try {
    const settings = SettingsSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const available = settings.availableModels;
    if (settings.model) {
      direct(declarations, path, "model", "settings.model", settings.model);
      if (available) memberships.push({ path, field: "availableModels", value: settings.model, values: available });
    }
    for (const [index, model] of (available ?? []).entries()) {
      direct(declarations, path, `availableModels[${index}]`, "settings.availableModels", model);
    }
    for (const [index, option] of (settings.modelPicker?.options ?? []).entries()) {
      direct(declarations, path, `modelPicker.options[${index}].model`, "settings.modelPicker", option.model);
      pickerRows.push({
        path,
        field: `modelPicker.options[${index}]`,
        model: option.model,
        behavesAs: option.behavesAs ?? null,
      });
      if (available) memberships.push({ path, field: "availableModels", value: option.model, values: available });
      if (option.behavesAs) {
        behaviorMappings.push({
          path,
          field: `modelPicker.options[${index}].behavesAs`,
          model: option.model,
          behavesAs: option.behavesAs,
        });
      }
    }
    for (const [key, value] of Object.entries(settings.env ?? {})) {
      const surface = modelEnvironmentSurface(key, "settings");
      if (surface) direct(declarations, path, `env.${key}`, surface, value);
    }
    return ok(undefined);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`failed to read Claude Code settings at ${path}: ${detail}`));
  }
}

function readAgents(path: string, declarations: ModelDeclaration[]): Result<void> {
  // Seats are routing vocabulary in model-routing.md; a host may carry no agent definitions at all.
  if (!existsSync(path)) return ok(undefined);
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
      const agentPath = join(path, entry.name);
      const match = FRONTMATTER.exec(readFileSync(agentPath, "utf8"));
      if (!match) return err(new Error(`agent definition has no YAML frontmatter: ${agentPath}`));
      const agent = AgentModelSchema.parse(Bun.YAML.parse(match[1] ?? ""));
      if (agent.model) direct(declarations, agentPath, "model", "agent.model", agent.model);
      if (agent.fallback_model) {
        direct(declarations, agentPath, "fallback_model", "agent.fallback_model", agent.fallback_model);
      }
    }
    return ok(undefined);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`failed to read agent definitions at ${path}: ${detail}`));
  }
}

function readLaunchers(
  config: Config,
  configPath: string,
  launchers: readonly Launcher[],
  declarations: ModelDeclaration[],
): LauncherServes[] {
  const localNames = new Set(config.launcher.map((launcher) => launcher.name));
  const fleet: LauncherServes[] = [];
  for (const launcher of launchers) {
    const sourcePath = localNames.has(launcher.name) ? configPath : config.routing.launchers;
    const modelEnvironmentKeys: string[] = [];
    for (const [key, value] of Object.entries(launcher.env)) {
      const surface = modelEnvironmentSurface(key, "launcher");
      if (!surface) continue;
      modelEnvironmentKeys.push(key);
      direct(declarations, sourcePath, `launcher.${launcher.name}.env.${key}`, surface, value);
    }
    fleet.push({ name: launcher.name, serves: launcher.serves, modelEnvironmentKeys, path: sourcePath });
  }
  return fleet;
}

function readLocations(path: string, declarations: ModelDeclaration[]): Result<void> {
  const loaded = loadLocationRegistry(path);
  if (!loaded.ok) return loaded;
  if (loaded.value.defaultModel) canonical(declarations, path, "default_model", loaded.value.defaultModel);
  for (const location of loaded.value.locations) {
    if (location.defaultModel) {
      canonical(declarations, path, `location.${location.key}.default_model`, location.defaultModel);
    }
  }
  return ok(undefined);
}

export async function collectModelDeclarations(
  options: ModelDeclarationsOptions = {},
): Promise<Result<ModelDeclarationsReport>> {
  const environment = options.environment ?? process.env;
  const home = environment.HOME ?? homedir();
  const claudeConfigDir = environment.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
  const settingsPath = options.settingsPath ?? join(claudeConfigDir, "settings.json");
  const agentsRoot = options.agentsRoot ?? environment.CCS_AGENTS_ROOT ?? join(home, ".claude", "agents");
  const configPath = options.configPath ?? CONFIG_PATH();
  const loadedConfig = loadConfig(configPath);
  if (!loadedConfig.ok) return loadedConfig;
  const config: Config = {
    ...loadedConfig.value,
    routing: {
      ...loadedConfig.value.routing,
      launchers: options.launcherRegistryPath ?? loadedConfig.value.routing.launchers,
      registry: options.locationRegistryPath ?? loadedConfig.value.routing.registry,
    },
  };
  const launchers = effectiveLaunchers(config);
  if (!launchers.ok) return launchers;
  const registry = loadModelRegistry(options.modelRegistryPath ?? config.routing.models);
  if (!registry.ok) return registry;

  const declarations: ModelDeclaration[] = [];
  const memberships: ModelMembershipRequirement[] = [];
  const behaviorMappings: ModelBehaviorMapping[] = [];
  const pickerRows: ModelPickerRow[] = [];

  for (const result of [
    readSettings(settingsPath, declarations, memberships, behaviorMappings, pickerRows),
    readAgents(agentsRoot, declarations),
    readLocations(config.routing.registry, declarations),
  ]) {
    if (!result.ok) return result;
  }
  const fleet = readLaunchers(config, configPath, launchers.value, declarations);

  const hermesPath = options.hermesConfigPath ?? join(home, ".hermes", "config.yaml");
  const pstackPath = options.pstackModelsPath
    ?? join(home, "Documents", "milad-vault", "ClaudeConfig", "plugins", "pstack", "models.json");
  const gatewayKeyPath = options.gatewayKeyPath ?? join(home, ".cli-proxy-api-key");
  const probe = options.fetchGatewayModels ?? ((value: ModelRegistry) => probeGatewayModels(value, gatewayKeyPath));

  return ok(buildModelDeclarationsReport({
    declarations,
    memberships,
    behaviorMappings,
    pickerRows,
    registry: registry.value,
    launchers: fleet,
    hermes: readHermes(hermesPath),
    pstack: readPstackModels(pstackPath),
    gatewayModels: await probe(registry.value),
  }));
}
