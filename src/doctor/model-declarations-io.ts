import { readFileSync, readdirSync } from "node:fs";
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
  type ModelBehaviorMapping,
  type ModelDeclaration,
  type ModelDeclarationsReport,
  type ModelMembershipRequirement,
} from "./model-declarations.ts";

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
  readonly environment?: NodeJS.ProcessEnv;
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
): void {
  const localNames = new Set(config.launcher.map((launcher) => launcher.name));
  for (const launcher of launchers) {
    const sourcePath = localNames.has(launcher.name) ? configPath : config.routing.launchers;
    for (const [key, value] of Object.entries(launcher.env)) {
      const surface = modelEnvironmentSurface(key, "launcher");
      if (surface) direct(declarations, sourcePath, `launcher.${launcher.name}.env.${key}`, surface, value);
    }
  }
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

export function collectModelDeclarations(
  options: ModelDeclarationsOptions = {},
): Result<ModelDeclarationsReport> {
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

  const declarations: ModelDeclaration[] = [];
  const memberships: ModelMembershipRequirement[] = [];
  const behaviorMappings: ModelBehaviorMapping[] = [];

  for (const result of [
    readSettings(settingsPath, declarations, memberships, behaviorMappings),
    readAgents(agentsRoot, declarations),
    readLocations(config.routing.registry, declarations),
  ]) {
    if (!result.ok) return result;
  }
  readLaunchers(config, configPath, launchers.value, declarations);

  return ok(buildModelDeclarationsReport({ declarations, memberships, behaviorMappings }));
}
