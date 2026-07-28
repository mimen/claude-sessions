import type { Launcher } from "./launchers.ts";
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
] as const;

export type BirthModelId = (typeof BIRTH_MODEL_IDS)[number];

/** The closed, authored role-model vocabulary. Values are canonical IDs, never aliases or launcher IDs. */
export const ROLE_MODEL_IDS = [
  "claude-opus-5",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly BirthModelId[];

export type RoleModelId = (typeof ROLE_MODEL_IDS)[number];

/** The vendor a canonical birth-model ID belongs to, read off its prefix. */
export type ModelFamily = "claude" | "gpt";

/**
 * Every launcher a managed birth may be routed to, and the model families each one can REACH.
 *
 * `claudex` is one gateway process holding OAuth credentials for both vendors, so it reaches
 * Claude and GPT alike; `claude-native` and the bare updater-managed `claude` reach Anthropic only;
 * `claude-gpt` is the GPT-only gateway wrapper `claudex` supersedes. This is the single table both
 * the birth compiler and the delegate seat loader validate against — one launcher can no longer be
 * derived from a model, because two of them serve the same one.
 */
export const LAUNCHER_FAMILIES = {
  claudex: ["claude", "gpt"],
  claude: ["claude"],
  "claude-native": ["claude"],
  "claude-gpt": ["gpt"],
} as const satisfies Readonly<Record<string, readonly ModelFamily[]>>;

export type LauncherName = keyof typeof LAUNCHER_FAMILIES;

export const LAUNCHER_NAMES = Object.keys(LAUNCHER_FAMILIES) as readonly LauncherName[];

/**
 * Launchers that reach models through the local CLIProxyAPI gateway. They need the `[1m]` context
 * declaration on a full model ID (Claude Code reads it; the gateway strips it); the direct-to-
 * Anthropic launchers take the canonical ID verbatim. This is a property of the LAUNCHER, not of
 * the model — the same `claude-opus-5` is spelled differently on `claudex` and on `claude-native`.
 */
export const GATEWAY_LAUNCHERS: ReadonlySet<LauncherName> = new Set<LauncherName>(["claudex", "claude-gpt"]);

export function parseLauncherName(value: string): LauncherName | null {
  return (LAUNCHER_NAMES as readonly string[]).includes(value) ? value as LauncherName : null;
}

export function modelFamily(model: BirthModelId): ModelFamily {
  return model.startsWith("gpt-") ? "gpt" : "claude";
}

/** Whether a launcher can physically reach a vendor at all. The one authority on the pairing. */
export function launcherServesFamily(launcher: LauncherName, family: ModelFamily): boolean {
  return (LAUNCHER_FAMILIES[launcher] as readonly ModelFamily[]).includes(family);
}

/** The launchers that reach a vendor, in table order — used to make refusals actionable. */
export function launchersServingFamily(family: ModelFamily): LauncherName[] {
  return LAUNCHER_NAMES.filter((launcher) => launcherServesFamily(launcher, family));
}

export function launcherReachesModel(launcher: LauncherName, model: BirthModelId): boolean {
  return launcherServesFamily(launcher, modelFamily(model));
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

/** Parse only exact, canonical fresh-birth model IDs. Aliases and gateway suffixes fail closed. */
export function parseBirthModel(value: unknown): BirthModelId | null {
  return typeof value === "string" && BIRTH_MODELS.has(value) ? value as BirthModelId : null;
}

/** Parse only exact, canonical role-model IDs. Inputs such as aliases and `[1m]` launch IDs fail closed. */
export function parseRoleModel(value: unknown): RoleModelId | null {
  return typeof value === "string" && ROLE_MODELS.has(value) ? value as RoleModelId : null;
}

/**
 * The executable descriptor for a launcher name. `serves` stays `["*"]` deliberately: this is an
 * EXECUTION descriptor (what to run), not a registry routing entry — resume eligibility is decided
 * by the `[[launcher]]` fleet in config.toml, never by a synthesized birth launcher.
 */
export function birthLauncher(name: LauncherName): Launcher {
  return { name, binary: name, serves: ["*"], env: {} };
}

/** The model spelling a given launcher accepts for a canonical birth-model ID. */
function launchModelFor(launcher: LauncherName, model: BirthModelId): string {
  if (!GATEWAY_LAUNCHERS.has(launcher)) return model;
  return model === "gpt-5.6-luna" ? `${model}(low)[1m]` : `${model}[1m]`;
}

/**
 * Compile a provider-neutral model declaration into its executable and launch spelling, with NO
 * harness declared. This is the implicit default and is deliberately unchanged by the `claudex`
 * consolidation: a caller that names only a model still lands on the direct Anthropic binary for
 * Claude models and on `claude-gpt` for GPT ones. Moving the fleet onto `claudex` is an explicit
 * `default_harness` decision in the location registry, not a silent rewrite of every birth.
 */
export function compileModelLaunch(model: BirthModelId): ModelLaunch {
  const launcher: LauncherName = modelFamily(model) === "gpt" ? "claude-gpt" : "claude";
  return { model, launcher: birthLauncher(launcher), launchModel: launchModelFor(launcher, model) };
}

/** Compile a model onto an EXPLICITLY declared launcher, once it is known to reach it. */
export function compileModelLaunchOn(launcher: LauncherName, model: BirthModelId): ModelLaunch {
  return { model, launcher: birthLauncher(launcher), launchModel: launchModelFor(launcher, model) };
}

/**
 * Validate and compile one registry-authored default_harness/default_model pair.
 *
 * The harness is HONORED, not re-derived: the pair is the fleet's declared default launch route
 * (`~/.ccs/config.toml`'s launcher fleet says what exists; the location registry says which one a
 * birth lands on). The check is reachability — does this launcher serve this model's vendor at all
 * — because a launcher can no longer be inferred from a model now that `claudex` serves both.
 */
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
      `location default_harness "${harness}" cannot reach model "${model}"; launchers that can: ${launchersServingFamily(modelFamily(parsed)).join(", ")}`,
    ));
  }
  return ok(compileModelLaunchOn(launcher, parsed));
}

/** Compile a role's provider-neutral model declaration into its launcher tuple. */
export function compileRoleModelLaunch(model: RoleModelId): RoleModelLaunch {
  return compileModelLaunch(model) as RoleModelLaunch;
}

/** Parse and compile one untrusted canonical model value through the birth-model contract. */
export function compileRoleModelValue(value: string): RoleModelLaunch | null {
  const model = parseRoleModel(value);
  return model ? compileRoleModelLaunch(model) : null;
}
