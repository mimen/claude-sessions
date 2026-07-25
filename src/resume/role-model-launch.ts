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

/** Compile a provider-neutral model declaration into its executable and launch spelling. */
export function compileModelLaunch(model: BirthModelId): ModelLaunch {
  if (model.startsWith("gpt-")) {
    return {
      model,
      launcher: { name: "claude-gpt", binary: "claude-gpt", serves: ["*"], env: {} },
      launchModel: model === "gpt-5.6-luna" ? `${model}(low)[1m]` : `${model}[1m]`,
    };
  }
  return {
    model,
    launcher: { name: "claude", binary: "claude", serves: ["*"], env: {} },
    launchModel: model,
  };
}

/** Validate and compile one registry-authored default_harness/default_model pair. */
export function compileLocationModelLaunch(harness: string, model: string): Result<ModelLaunch> {
  const parsed = parseBirthModel(model);
  if (!parsed) {
    return err(new Error(
      `location default_model "${model}" is unsupported; expected one of: ${BIRTH_MODEL_IDS.join(", ")}`,
    ));
  }
  const compiled = compileModelLaunch(parsed);
  if (harness !== compiled.launcher.name) {
    return err(new Error(
      `location default_harness "${harness}" contradicts model "${model}"; expected "${compiled.launcher.name}"`,
    ));
  }
  return ok(compiled);
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
