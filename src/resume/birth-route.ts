import { type Result, err, ok } from "../result.ts";
import { DEFAULT_LAUNCHERS, launcherByName, loadLaunchers, type Launcher } from "./launchers.ts";
import {
  birthLauncher,
  compileLocationModelLaunch,
  compileModelLaunch,
  compileRoleModelLaunch,
  parseBirthModel,
  parseLauncherName,
  type BirthModelId,
  type RoleModelId,
} from "./role-model-launch.ts";

export interface ExactBirthRoute {
  readonly launcher: string;
  readonly model: BirthModelId | null;
  readonly launchModel: string | null;
}

export interface BirthRouteRequest {
  readonly roleModel?: RoleModelId | null;
  readonly model?: string | null;
  readonly via?: string | null;
  readonly locationKey: string;
  readonly defaultHarness?: string | null;
  readonly defaultModel?: string | null;
}

export interface ResolvedBirthRoute {
  readonly exact: ExactBirthRoute;
  readonly launcher: Launcher;
}

export type LauncherRegistryLoader = () => Result<readonly Launcher[]>;

/** Compile route intent without consulting this machine's launcher registry. */
export function compileExactBirthRoute(request: BirthRouteRequest): Result<ExactBirthRoute> {
  let explicitModel: BirthModelId | null = null;
  if (request.model) {
    if (request.via) {
      return err(new Error("--model cannot be combined with --via; the model determines its launcher"));
    }
    explicitModel = parseBirthModel(request.model);
    if (!explicitModel) return err(new Error(`unsupported --model "${request.model}"`));
  }

  if (request.roleModel) {
    if (request.via || explicitModel) {
      return err(new Error("--via/--model cannot be combined with a role-declared model policy"));
    }
    const compiled = compileRoleModelLaunch(request.roleModel);
    return ok({
      launcher: compiled.launcher.name,
      model: compiled.model,
      launchModel: compiled.launchModel,
    });
  }

  if (explicitModel) {
    const compiled = compileModelLaunch(explicitModel);
    return ok({
      launcher: compiled.launcher.name,
      model: compiled.model,
      launchModel: compiled.launchModel,
    });
  }

  if (request.via) {
    return ok({ launcher: request.via, model: null, launchModel: null });
  }

  if (Boolean(request.defaultHarness) !== Boolean(request.defaultModel)) {
    return err(new Error(
      `location "${request.locationKey}" must resolve both default_harness and default_model, or neither`,
    ));
  }
  if (request.defaultHarness && request.defaultModel) {
    const compiled = compileLocationModelLaunch(request.defaultHarness, request.defaultModel);
    if (!compiled.ok) {
      return err(new Error(`location "${request.locationKey}" has an invalid launch route: ${compiled.error.message}`));
    }
    return ok({
      launcher: compiled.value.launcher.name,
      model: compiled.value.model,
      launchModel: compiled.value.launchModel,
    });
  }

  const launcher = DEFAULT_LAUNCHERS[0]!;
  return ok({ launcher: launcher.name, model: null, launchModel: null });
}

/** Resolve the compiled route against the launcher registry used by the machine that will run it. */
export function resolveBirthRoute(
  request: BirthRouteRequest,
  loadRegistry: LauncherRegistryLoader = loadLaunchers,
): Result<ResolvedBirthRoute> {
  const exact = compileExactBirthRoute(request);
  if (!exact.ok) return exact;

  if (request.via) {
    const launchers = loadRegistry();
    if (!launchers.ok) return launchers;
    const launcher = launcherByName(launchers.value, request.via);
    if (!launcher) {
      const known = launchers.value.map((candidate) => candidate.name).join(", ");
      return err(new Error(`unknown launcher "${request.via}" (configured: ${known})`));
    }
    return ok({ exact: exact.value, launcher });
  }

  if (exact.value.model) {
    // Resolve the launcher the route ALREADY compiled, never re-derive it from the model: a
    // location that declares `default_harness = "claudex"` picks a launcher the model alone cannot
    // name, and re-deriving here would silently send the birth to a different backend.
    const named = parseLauncherName(exact.value.launcher);
    return ok({
      exact: exact.value,
      launcher: named ? birthLauncher(named) : compileModelLaunch(exact.value.model).launcher,
    });
  }

  return ok({ exact: exact.value, launcher: DEFAULT_LAUNCHERS[0]! });
}
