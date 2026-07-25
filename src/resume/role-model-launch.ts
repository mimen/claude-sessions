import type { Launcher } from "./launchers.ts";

/** The closed, authored role-model vocabulary. Values are canonical IDs, never aliases or launcher IDs. */
export const ROLE_MODEL_IDS = [
  "claude-opus-4-8",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

export type RoleModelId = (typeof ROLE_MODEL_IDS)[number];

export interface RoleModelLaunch {
  readonly model: RoleModelId;
  readonly launcher: Launcher;
  /** The model spelling accepted by the selected launcher. */
  readonly launchModel: string;
}

const ROLE_MODELS = new Set<string>(ROLE_MODEL_IDS);

/** Parse only exact, canonical role-model IDs. Inputs such as aliases and `[1m]` launch IDs fail closed. */
export function parseRoleModel(value: unknown): RoleModelId | null {
  return typeof value === "string" && ROLE_MODELS.has(value) ? value as RoleModelId : null;
}

/** Compile a role's provider-neutral model declaration into its launcher tuple. */
export function compileRoleModelLaunch(model: RoleModelId): RoleModelLaunch {
  switch (model) {
    case "claude-opus-4-8":
      return {
        model,
        launcher: { name: "claude", binary: "claude", serves: ["*"], env: {} },
        launchModel: model,
      };
    case "gpt-5.6-terra":
    case "gpt-5.6-sol":
      return {
        model,
        launcher: { name: "claude-gpt", binary: "claude-gpt", serves: ["*"], env: {} },
        launchModel: `${model}[1m]`,
      };
  }
}

/** Parse and compile one untrusted canonical model value through the birth-model contract. */
export function compileRoleModelValue(value: string): RoleModelLaunch | null {
  const model = parseRoleModel(value);
  return model ? compileRoleModelLaunch(model) : null;
}
