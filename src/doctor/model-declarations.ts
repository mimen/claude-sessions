import { canonicalModelId, claudeCodeModelId, unregisteredRoleModelIds } from "../resume/role-model-launch.ts";
import { matchesModel } from "../resume/launchers.ts";
import {
  activeDeclarationReplacements,
  familyOf,
  modelBase,
  requireModelRegistry,
  slots,
  SLOT_ENVIRONMENT_KEYS,
  type ModelRegistry,
} from "../models/registry.ts";

export type ModelDeclarationSurface =
  | "settings.model"
  | "settings.availableModels"
  | "settings.modelPicker"
  | "settings.modelPicker.behavesAs"
  | "settings.environment"
  | "settings.subagentModel"
  | "agent.model"
  | "agent.fallback_model"
  | "launcher.environment"
  | "launcher.slot"
  | "routing.default_model";

export type ModelDeclarationMode = "direct" | "canonical";

export interface ModelDeclaration {
  readonly path: string;
  readonly field: string;
  readonly surface: ModelDeclarationSurface;
  readonly mode: ModelDeclarationMode;
  readonly value: string;
}

export interface ModelMembershipRequirement {
  readonly path: string;
  readonly field: string;
  readonly value: string;
  readonly values: readonly string[];
}

export interface ModelBehaviorMapping {
  readonly path: string;
  readonly field: string;
  readonly model: string;
  readonly behavesAs: string;
}

/** One `/model` row as some settings file actually spells it, mapping or not. */
export interface ModelPickerRow {
  readonly path: string;
  readonly field: string;
  readonly model: string;
  readonly behavesAs: string | null;
}

/** A launcher's routing globs, for checking them against the launchers a registry row names. */
export interface LauncherServes {
  readonly name: string;
  readonly serves: readonly string[];
  /** Model-bearing environment keys this fleet entry still spells for itself. */
  readonly modelEnvironmentKeys: readonly string[];
  readonly path: string;
}

/** A model id named by a policy file the registry does not generate. */
export interface PolicyModelReference {
  readonly path: string;
  readonly field: string;
  readonly value: string;
}

export interface ModelDeclarationsInput {
  readonly declarations: readonly ModelDeclaration[];
  readonly memberships: readonly ModelMembershipRequirement[];
  readonly behaviorMappings: readonly ModelBehaviorMapping[];
  readonly registry?: ModelRegistry;
  readonly pickerRows?: readonly ModelPickerRow[];
  readonly launchers?: readonly LauncherServes[];
  /** `~/.hermes/config.yaml` model selectors. */
  readonly hermes?: readonly PolicyModelReference[];
  /** `plugins/pstack/models.json` role defaults. */
  readonly pstack?: readonly PolicyModelReference[];
  /** Model ids the live gateway advertises; null when it could not be reached. */
  readonly gatewayModels?: readonly string[] | null;
  readonly gatewayUrl?: string;
}

export type ModelFindingSeverity = "error" | "warning";

export interface ModelDeclarationFinding {
  readonly check: string;
  readonly path: string;
  readonly field: string;
  readonly actual: string;
  readonly expected: string;
  readonly severity: ModelFindingSeverity;
}

export interface ModelDeclarationsReport {
  readonly findings: readonly ModelDeclarationFinding[];
  /** Context-window accounting facts. Never a failure: they say what a window really resolves to. */
  readonly notes: readonly string[];
}

/**
 * Claude Code's own tier aliases. They name a slot rather than a model, so the registry has no row
 * for them and an unregistered-id check must not treat one as drift.
 */
const TIER_ALIASES = new Set(["best", "default", "fable", "haiku", "opus", "opusplan", "sonnet"]);

function activeDeclarationModelId(model: string, registry: ModelRegistry): string {
  const canonical = canonicalModelId(model);
  return activeDeclarationReplacements(registry).get(canonical) ?? canonical;
}

export function expectedModelDeclaration(
  declaration: ModelDeclaration,
  registry: ModelRegistry = requireModelRegistry(),
): string {
  const active = activeDeclarationModelId(declaration.value, registry);
  return declaration.mode === "direct" ? claudeCodeModelId(active, registry) : active;
}

function knownModelId(registry: ModelRegistry, value: string): boolean {
  const base = modelBase(value);
  if (TIER_ALIASES.has(base)) return true;
  return registry.model.some((model) => model.id === base)
    || registry.historical.some((row) => row.id === base);
}

/**
 * The window Claude Code actually accounts a model at, given how its family declares itself. A
 * `behaves_as` row gets the donor's window, and a bare Claude 5 id is 200K by Claude Code's own
 * catalogue; an `envelope` row gets whatever the launcher's `max_context` slot says.
 */
function accountedWindow(registry: ModelRegistry, modelId: string, launcher: string): number | null {
  const family = familyOf(registry, modelId);
  if (!family) return null;
  if (family.accounting === "marker") return family.window;
  if (family.accounting === "behaves_as") {
    const donor = family.behaves_as ? familyOf(registry, family.behaves_as) : null;
    // A bare Claude 5 id is the 200K spelling; the donor's own 1M marker is not applied through
    // a behavesAs mapping.
    return donor && donor.accounting === "marker" && (donor.marker ?? "") !== "" ? 200_000 : donor?.window ?? null;
  }
  return slots(registry, launcher)?.max_context ?? null;
}

function finding(
  check: string,
  path: string,
  field: string,
  actual: string,
  expected: string,
  severity: ModelFindingSeverity = "error",
): ModelDeclarationFinding {
  return { check, path, field, actual, expected, severity };
}

export function buildModelDeclarationsReport(input: ModelDeclarationsInput): ModelDeclarationsReport {
  const registry = input.registry ?? requireModelRegistry();
  const findings: ModelDeclarationFinding[] = [];
  const notes: string[] = [];

  for (const declaration of input.declarations) {
    const expected = expectedModelDeclaration(declaration, registry);
    if (declaration.value !== expected) {
      findings.push(finding(declaration.surface, declaration.path, declaration.field, declaration.value, expected));
      continue;
    }
    if (!knownModelId(registry, declaration.value)) {
      findings.push(finding(
        "model.unregistered",
        declaration.path,
        declaration.field,
        declaration.value,
        "an active or historical id in the model registry",
      ));
    }
  }

  for (const membership of input.memberships) {
    if (membership.values.includes(membership.value)) continue;
    findings.push(finding(
      "settings.availableModels",
      membership.path,
      membership.field,
      JSON.stringify(membership.values),
      `contains ${JSON.stringify(membership.value)}`,
    ));
  }

  for (const row of input.pickerRows ?? []) {
    const family = familyOf(registry, row.model);
    if (!family) continue;
    const donor = family.accounting === "behaves_as" ? family.behaves_as ?? null : null;
    if (donor === row.behavesAs) continue;
    findings.push(finding(
      "settings.modelPicker.behavesAs",
      row.path,
      row.field,
      row.behavesAs ?? "omitted",
      donor
        ? `behavesAs ${JSON.stringify(donor)}, the donor family "${family.name}" accounts through`
        : `omitted: family "${family.name}" is accounted by its ${family.accounting}, and a behavesAs `
          + "mapping would drop this row to the donor's 200K window and ignore CLAUDE_CODE_MAX_CONTEXT_TOKENS",
    ));
  }

  // A mapping on a row whose family this build has never seen is still reportable: the registry is
  // the only thing that can say a mapping is safe.
  for (const mapping of input.behaviorMappings) {
    if (familyOf(registry, mapping.model)) continue;
    findings.push(finding(
      "settings.modelPicker.behavesAs",
      mapping.path,
      mapping.field,
      mapping.behavesAs,
      "omitted: no registry family claims this model, so nothing accounts for its window",
    ));
  }

  const launchers = new Map((input.launchers ?? []).map((launcher) => [launcher.name, launcher]));
  for (const model of registry.model) {
    for (const name of model.launchers) {
      const launcher = launchers.get(name);
      if (!launcher) continue;
      if (launcher.serves.some((pattern) => matchesModel(pattern, model.id))) continue;
      findings.push(finding(
        "launcher.serves",
        launcher.path,
        `launcher.${name}.serves`,
        JSON.stringify(launcher.serves),
        `a glob matching "${model.id}", which the model registry routes to this launcher`,
      ));
    }
  }

  for (const launcher of input.launchers ?? []) {
    const table = slots(registry, launcher.name);
    if (!table) continue;
    const generated = new Set<string>(
      Object.entries(SLOT_ENVIRONMENT_KEYS)
        .filter(([slot]) => table[slot as keyof typeof table] !== undefined)
        .map(([, key]) => key),
    );
    for (const key of launcher.modelEnvironmentKeys) {
      if (!generated.has(key)) continue;
      findings.push(finding(
        "launcher.slot",
        launcher.path,
        `launcher.${launcher.name}.env.${key}`,
        "spelled in the launcher fleet",
        "removed: the model registry's [slots] table already sets this key",
        "warning",
      ));
    }
  }

  for (const reference of [...(input.hermes ?? []), ...(input.pstack ?? [])]) {
    if (knownModelId(registry, reference.value)) continue;
    findings.push(finding(
      "policy.unregistered",
      reference.path,
      reference.field,
      reference.value,
      "an active or historical id in the model registry",
      "warning",
    ));
  }

  for (const model of unregisteredRoleModelIds(registry)) {
    findings.push(finding(
      "role.model",
      "src/resume/role-model-launch.ts",
      "ROLE_MODEL_IDS",
      model,
      "a registry model with birth = true",
    ));
  }

  const gatewayUrl = input.gatewayUrl ?? registry.gateway ?? "the gateway";
  if (input.gatewayModels === null) {
    findings.push(finding(
      "gateway.catalogue",
      gatewayUrl,
      "/v1/models",
      "unreachable",
      "a reachable gateway; run this again once it is up",
      "warning",
    ));
  } else if (input.gatewayModels !== undefined) {
    const served = new Set(input.gatewayModels);
    for (const model of registry.model) {
      if (served.has(model.id)) continue;
      findings.push(finding(
        "gateway.catalogue",
        gatewayUrl,
        "/v1/models",
        `missing ${model.id}`,
        "every active registry model is routable at the gateway",
      ));
    }
  }

  for (const model of registry.model) {
    const family = familyOf(registry, model.id);
    if (!family) continue;
    for (const launcher of model.launchers) {
      const accounted = accountedWindow(registry, model.id, launcher);
      if (accounted === null || accounted === family.window) continue;
      notes.push(
        `${model.id} on ${launcher}: real window ${family.window}, accounted ${accounted} `
          + `(${family.accounting})`,
      );
    }
  }

  return { findings, notes };
}

export function renderModelDeclarationsReport(report: ModelDeclarationsReport): string {
  const lines = ["Model declaration drift"];
  for (const finding of report.findings) {
    const tag = finding.severity === "error" ? "DRIFT" : "WARN ";
    lines.push(`  ${tag} ${finding.check.padEnd(26)} ${finding.path} ${finding.field}`);
    lines.push(`        actual: ${JSON.stringify(finding.actual)}`);
    lines.push(`      expected: ${JSON.stringify(finding.expected)}`);
  }
  for (const note of report.notes) lines.push(`  NOTE  ${note}`);
  const errors = report.findings.filter((entry) => entry.severity === "error").length;
  const warnings = report.findings.length - errors;
  lines.push(
    errors === 0
      ? `OK - model declarations match their context windows.${warnings > 0 ? ` ${warnings} warning(s).` : ""}`
      : `${errors} drift finding(s), ${warnings} warning(s). Nothing was changed.`,
  );
  return lines.join("\n");
}

export function modelDeclarationsExitCode(report: ModelDeclarationsReport): number {
  return report.findings.some((finding) => finding.severity === "error") ? 1 : 0;
}
