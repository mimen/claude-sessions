/**
 * Compiling a canonical model id onto a launcher.
 *
 * Every fact this module used to hard-code (which models exist, which launcher hosts which,
 * which family carries Claude Code's 1M marker, which model wants a cheap effort suffix) is read
 * from the shared model registry (`src/models/registry.ts`). What stays authored HERE is policy:
 * `ROLE_MODEL_IDS`, the closed vocabulary a role may declare, which is a decision about how work
 * is routed rather than a fact about what the gateway can serve.
 *
 * Ids are BRANDED rather than literal unions because the vocabulary is now data: a value earns its
 * type by being parsed against the registry, so no build-time list can disagree with the file.
 */
import { type Launcher, matchesModel } from "./launchers.ts";
import { type Result, err, ok } from "../result.ts";
import {
  activeDeclarationReplacements,
  birthModelIds as registryBirthModelIds,
  canonicalModelId,
  claudeCodeDeclaration,
  familyOf,
  isMarkerLauncher,
  launcherNames,
  modelBase,
  modelById,
  requireModelRegistry,
  type ModelRegistry,
} from "../models/registry.ts";

export { canonicalModelId };

declare const birthModelBrand: unique symbol;
declare const roleModelBrand: unique symbol;
declare const launcherNameBrand: unique symbol;

/** A canonical model id the registry accepts for a fresh managed birth. */
export type BirthModelId = string & { readonly [birthModelBrand]: true };
/** A birth model that the authored role vocabulary also permits. */
export type RoleModelId = BirthModelId & { readonly [roleModelBrand]: true };
/** A launcher name the registry knows. */
export type LauncherName = string & { readonly [launcherNameBrand]: true };

/** The closed, authored role-model vocabulary. Values are canonical IDs, never aliases or launcher IDs. */
export const ROLE_MODEL_IDS = [
  "claude-opus-5",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const satisfies readonly string[];

/** The provider a model belongs to, for provenance display. Never a routing input. */
export type ModelFamily = "claude" | "gpt" | "other";

/** Canonical ids CCS can compile for a fresh managed birth. */
export function birthModelIds(registry: ModelRegistry = requireModelRegistry()): readonly BirthModelId[] {
  return registryBirthModelIds(registry) as readonly BirthModelId[];
}

/** Compatibility ids and the active declaration each one should be written as instead. */
export function activeModelDeclarationReplacements(
  registry: ModelRegistry = requireModelRegistry(),
): ReadonlyMap<string, string> {
  return activeDeclarationReplacements(registry);
}

/** The launcher names the registry knows, in registry order. */
export function launcherNamesOf(registry: ModelRegistry = requireModelRegistry()): readonly LauncherName[] {
  return launcherNames(registry) as readonly LauncherName[];
}

/** Id prefixes whose Claude family carries a non-empty context marker. */
export function millionWindowClaudeFamilies(
  registry: ModelRegistry = requireModelRegistry(),
): readonly string[] {
  return registry.family
    .filter((family) => family.accounting === "marker" && (family.marker ?? "") !== "")
    .flatMap((family) => family.prefixes);
}

/** Whether the model's family carries a non-empty Claude Code context marker. */
export function claudeModelUsesMillionWindow(
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): boolean {
  const family = familyOf(registry, model);
  return family?.accounting === "marker" && (family.marker ?? "") !== "";
}

/** Compile a direct Claude Code model declaration without changing provider-canonical routing IDs. */
export function claudeCodeModelId(
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): string {
  const canonical = canonicalModelId(model);
  const family = familyOf(registry, canonical);
  if (!family || family.accounting !== "marker") return canonical;
  return `${canonical}${family.marker ?? ""}`;
}

export function parseLauncherName(
  value: string,
  registry: ModelRegistry = requireModelRegistry(),
): LauncherName | null {
  return launcherNames(registry).includes(value) ? value as LauncherName : null;
}

export function modelFamily(
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): ModelFamily {
  const family = familyOf(registry, model);
  const name = family?.name ?? modelBase(model);
  if (name.startsWith("claude")) return "claude";
  if (name.startsWith("gpt")) return "gpt";
  return "other";
}

/** Whether a launcher's process envelope can safely host this exact model. */
export function launcherReachesModel(
  launcher: string,
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): boolean {
  return modelById(registry, canonicalModelId(model))?.launchers.includes(launcher) ?? false;
}

/** The launchers that can safely host one exact model, in registry order. */
export function launchersServingModel(
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): LauncherName[] {
  return launcherNamesOf(registry).filter((launcher) => launcherReachesModel(launcher, model, registry));
}

/** Whether a launcher has at least one safe model in a provider family. */
export function launcherServesFamily(
  launcher: string,
  family: ModelFamily,
  registry: ModelRegistry = requireModelRegistry(),
): boolean {
  return registry.model.some(
    (model) => modelFamily(model.id, registry) === family && model.launchers.includes(launcher),
  );
}

/** The launchers that reach a provider family, in registry order. */
export function launchersServingFamily(
  family: ModelFamily,
  registry: ModelRegistry = requireModelRegistry(),
): LauncherName[] {
  return launcherNamesOf(registry).filter((launcher) => launcherServesFamily(launcher, family, registry));
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

/** Parse only exact, canonical fresh-birth model IDs. Aliases and launcher suffixes fail closed. */
export function parseBirthModel(
  value: unknown,
  registry: ModelRegistry = requireModelRegistry(),
): BirthModelId | null {
  if (typeof value !== "string") return null;
  const row = modelById(registry, value);
  return row?.birth ? value as BirthModelId : null;
}

/** Parse only exact, canonical role-model IDs. Inputs such as aliases and `[1m]` launch IDs fail closed. */
export function parseRoleModel(
  value: unknown,
  registry: ModelRegistry = requireModelRegistry(),
): RoleModelId | null {
  if (typeof value !== "string" || !(ROLE_MODEL_IDS as readonly string[]).includes(value)) return null;
  return parseBirthModel(value, registry) as RoleModelId | null;
}

/** Every authored role model must still be a registry birth model; the doctor reports the gap. */
export function unregisteredRoleModelIds(
  registry: ModelRegistry = requireModelRegistry(),
): readonly string[] {
  return ROLE_MODEL_IDS.filter((model) => parseBirthModel(model, registry) === null);
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
export function launchModelFor(
  launcher: string,
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): string {
  const canonical = canonicalModelId(model);
  const effort = modelById(registry, canonical)?.launch_effort;
  const requested = effort && isMarkerLauncher(registry, launcher) ? `${canonical}(${effort})` : canonical;
  return claudeCodeDeclaration(registry, requested, launcher);
}

/**
 * The launcher a model lands on when nothing names one: the first launcher its own row lists. A
 * compatibility row (`replaced_by`) declares no launchers of its own and borrows its replacement's.
 */
function defaultLauncherFor(model: BirthModelId, registry: ModelRegistry): Result<LauncherName> {
  const row = modelById(registry, model);
  const hosts = row?.launchers.length
    ? row.launchers
    : (row?.replaced_by ? modelById(registry, row.replaced_by)?.launchers ?? [] : []);
  const launcher = hosts[0];
  if (!launcher) return err(new Error(`model "${model}" declares no launcher in the model registry`));
  return ok(launcher as LauncherName);
}

/** Compile a provider-neutral model declaration onto its dedicated default process envelope. */
export function compileModelLaunch(
  model: BirthModelId,
  registry: ModelRegistry = requireModelRegistry(),
): ModelLaunch {
  const launcher = defaultLauncherFor(model, registry);
  if (!launcher.ok) throw launcher.error;
  return compileModelLaunchOn(launcher.value, model, registry);
}

/** Compile a model onto an explicitly declared launcher, once it is known to reach it. */
export function compileModelLaunchOn(
  launcher: LauncherName,
  model: BirthModelId,
  registry: ModelRegistry = requireModelRegistry(),
): ModelLaunch {
  return {
    model,
    launcher: birthLauncher(launcher),
    launchModel: launchModelFor(launcher, model, registry),
  };
}

/** Validate and compile one registry-authored default_harness/default_model pair. */
export function compileLocationModelLaunch(
  harness: string,
  model: string,
  registry: ModelRegistry = requireModelRegistry(),
): Result<ModelLaunch> {
  const parsed = parseBirthModel(model, registry);
  if (!parsed) {
    return err(new Error(
      `location default_model "${model}" is unsupported; expected one of: ${birthModelIds(registry).join(", ")}`,
    ));
  }
  const launcher = parseLauncherName(harness, registry);
  if (!launcher) {
    return err(new Error(
      `location default_harness "${harness}" is unknown; expected one of: ${launcherNamesOf(registry).join(", ")}`,
    ));
  }
  if (!launcherReachesModel(launcher, parsed, registry)) {
    return err(new Error(
      `location default_harness "${harness}" cannot reach model "${model}"; launchers that can: ${launchersServingModel(parsed, registry).join(", ")}`,
    ));
  }
  return ok(compileModelLaunchOn(launcher, parsed, registry));
}

/** Compile a role's provider-neutral model declaration into its launcher tuple. */
export function compileRoleModelLaunch(
  model: RoleModelId,
  registry: ModelRegistry = requireModelRegistry(),
): RoleModelLaunch {
  return compileModelLaunch(model, registry) as RoleModelLaunch;
}

/** Parse and compile one untrusted canonical role-model value. */
export function compileRoleModelValue(
  value: string,
  registry: ModelRegistry = requireModelRegistry(),
): RoleModelLaunch | null {
  const model = parseRoleModel(value, registry);
  return model ? compileRoleModelLaunch(model, registry) : null;
}

/** Whether a launcher's `serves` globs cover a model id, for launcher-versus-registry drift. */
export function servesMatchesModel(launcher: Launcher, model: string): boolean {
  return launcher.serves.some((pattern) => matchesModel(pattern, model));
}
