import { type Launcher, matchesModel } from "./launchers.ts";
import { type Result, err, ok } from "../result.ts";

/** Canonical model IDs that CCS can compile for a fresh managed birth. */
export const BIRTH_MODEL_IDS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "qwen3.8-local",
] as const;

export type BirthModelId = (typeof BIRTH_MODEL_IDS)[number];

/** The closed, authored role-model vocabulary. Values are canonical IDs, never aliases or launcher IDs. */
export const ROLE_MODEL_IDS = [
  "claude-opus-5",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly BirthModelId[];

export type RoleModelId = (typeof ROLE_MODEL_IDS)[number];

/** The provider family a canonical birth-model ID belongs to. */
export type ModelFamily = "claude" | "gpt" | "local";

/**
 * Every launcher a managed birth may use, and the exact model IDs each process envelope can safely
 * host. Context limits are process-wide in Claude Code, so sharing a provider is not sufficient:
 * GPT-5.6, GPT-5.5, and local MLX each need a launcher with their own real window.
 */
export const LAUNCHER_MODEL_PATTERNS = {
  claudex: ["claude-*", "gpt-5.6-*"],
  claude: ["claude-*"],
  "claude-native": ["claude-*"],
  "claude-gpt": ["gpt-5.6-*"],
  "claude-gpt55": ["gpt-5.5"],
  "local-mlx": ["qwen3.8-local"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type LauncherName = keyof typeof LAUNCHER_MODEL_PATTERNS;

export const LAUNCHER_NAMES = Object.keys(LAUNCHER_MODEL_PATTERNS) as readonly LauncherName[];

/** The gateway launcher whose Claude model IDs need Claude Code's client-side 1M marker. */
export const ONE_MILLION_MARKER_LAUNCHERS: ReadonlySet<LauncherName> = new Set<LauncherName>(["claudex"]);

export function parseLauncherName(value: string): LauncherName | null {
  return (LAUNCHER_NAMES as readonly string[]).includes(value) ? value as LauncherName : null;
}

export function modelFamily(model: BirthModelId): ModelFamily {
  if (model.startsWith("gpt-")) return "gpt";
  if (model.startsWith("qwen")) return "local";
  return "claude";
}

/** Whether a launcher has at least one safe model in a provider family. */
export function launcherServesFamily(launcher: LauncherName, family: ModelFamily): boolean {
  return BIRTH_MODEL_IDS.some(
    (model) => modelFamily(model) === family && launcherReachesModel(launcher, model),
  );
}

/** The launchers that reach a provider family, in table order. */
export function launchersServingFamily(family: ModelFamily): LauncherName[] {
  return LAUNCHER_NAMES.filter((launcher) => launcherServesFamily(launcher, family));
}

/** Whether a launcher's process envelope can safely host this exact model. */
export function launcherReachesModel(launcher: LauncherName, model: BirthModelId): boolean {
  return LAUNCHER_MODEL_PATTERNS[launcher].some((pattern) => matchesModel(pattern, model));
}

/** The launchers that can safely host one exact model, in table order. */
export function launchersServingModel(model: BirthModelId): LauncherName[] {
  return LAUNCHER_NAMES.filter((launcher) => launcherReachesModel(launcher, model));
}

export interface ModelLaunch {
  readonly model: BirthModelId;
  readonly launcher: Launcher;
  /** The model spelling accepted by the selected launcher. */
  readonly launchModel: string;
}

export interface RoleModelLaunch extends ModelLaunch {
  readonly model: RoleModelId;
}

const BIRTH_MODELS = new Set<string>(BIRTH_MODEL_IDS);
const ROLE_MODELS = new Set<string>(ROLE_MODEL_IDS);

/** Parse only exact, canonical fresh-birth model IDs. Aliases and launcher suffixes fail closed. */
export function parseBirthModel(value: unknown): BirthModelId | null {
  return typeof value === "string" && BIRTH_MODELS.has(value) ? value as BirthModelId : null;
}

/** Parse only exact, canonical role-model IDs. Inputs such as aliases and `[1m]` launch IDs fail closed. */
export function parseRoleModel(value: unknown): RoleModelId | null {
  return typeof value === "string" && ROLE_MODELS.has(value) ? value as RoleModelId : null;
}

/**
 * The executable descriptor for a launcher name. `serves` stays `["*"]` deliberately: this is an
 * EXECUTION descriptor (what to run), not a registry routing entry. Resume eligibility is decided by
 * the authored `[[launcher]]` fleet, never by a synthesized birth launcher.
 */
export function birthLauncher(name: LauncherName): Launcher {
  return { name, binary: name, serves: ["*"], env: {}, clears: [] };
}

/** The model spelling a given launcher accepts for a canonical birth-model ID. */
export function launchModelFor(launcher: LauncherName, model: BirthModelId): string {
  if (model === "gpt-5.6-luna" && (launcher === "claudex" || launcher === "claude-gpt")) {
    return `${model}(low)`;
  }
  if (modelFamily(model) === "claude" && ONE_MILLION_MARKER_LAUNCHERS.has(launcher)) {
    return `${model}[1m]`;
  }
  return model;
}

function defaultLauncherFor(model: BirthModelId): LauncherName {
  if (model === "qwen3.8-local") return "local-mlx";
  if (model === "gpt-5.5") return "claude-gpt55";
  if (model.startsWith("gpt-5.6-")) return "claude-gpt";
  return "claudex";
}

/** Compile a provider-neutral model declaration onto its dedicated default process envelope. */
export function compileModelLaunch(model: BirthModelId): ModelLaunch {
  const launcher = defaultLauncherFor(model);
  return { model, launcher: birthLauncher(launcher), launchModel: launchModelFor(launcher, model) };
}

/** Compile a model onto an explicitly declared launcher, once it is known to reach it. */
export function compileModelLaunchOn(launcher: LauncherName, model: BirthModelId): ModelLaunch {
  return { model, launcher: birthLauncher(launcher), launchModel: launchModelFor(launcher, model) };
}

/** Validate and compile one registry-authored default_harness/default_model pair. */
export function compileLocationModelLaunch(harness: string, model: string): Result<ModelLaunch> {
  const parsed = parseBirthModel(model);
  if (!parsed) {
    return err(new Error(
      `location default_model "${model}" is unsupported; expected one of: ${BIRTH_MODEL_IDS.join(", ")}`,
    ));
  }
  const launcher = parseLauncherName(harness);
  if (!launcher) {
    return err(new Error(
      `location default_harness "${harness}" is unknown; expected one of: ${LAUNCHER_NAMES.join(", ")}`,
    ));
  }
  if (!launcherReachesModel(launcher, parsed)) {
    return err(new Error(
      `location default_harness "${harness}" cannot reach model "${model}"; launchers that can: ${launchersServingModel(parsed).join(", ")}`,
    ));
  }
  return ok(compileModelLaunchOn(launcher, parsed));
}

/** Compile a role's provider-neutral model declaration into its launcher tuple. */
export function compileRoleModelLaunch(model: RoleModelId): RoleModelLaunch {
  return compileModelLaunch(model) as RoleModelLaunch;
}

/** Parse and compile one untrusted canonical role-model value. */
export function compileRoleModelValue(value: string): RoleModelLaunch | null {
  const model = parseRoleModel(value);
  return model ? compileRoleModelLaunch(model) : null;
}
