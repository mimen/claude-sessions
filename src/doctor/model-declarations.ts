import {
  ACTIVE_MODEL_DECLARATION_REPLACEMENTS,
  canonicalModelId,
  claudeCodeModelId,
} from "../resume/role-model-launch.ts";

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

export interface ModelDeclarationsInput {
  readonly declarations: readonly ModelDeclaration[];
  readonly memberships: readonly ModelMembershipRequirement[];
  readonly behaviorMappings: readonly ModelBehaviorMapping[];
}

export interface ModelDeclarationFinding {
  readonly check: string;
  readonly path: string;
  readonly field: string;
  readonly actual: string;
  readonly expected: string;
}

export interface ModelDeclarationsReport {
  readonly findings: readonly ModelDeclarationFinding[];
}

function activeDeclarationModelId(model: string): string {
  const canonical = canonicalModelId(model);
  return ACTIVE_MODEL_DECLARATION_REPLACEMENTS.get(canonical) ?? canonical;
}

export function expectedModelDeclaration(declaration: ModelDeclaration): string {
  const active = activeDeclarationModelId(declaration.value);
  return declaration.mode === "direct" ? claudeCodeModelId(active) : active;
}

export function buildModelDeclarationsReport(input: ModelDeclarationsInput): ModelDeclarationsReport {
  const findings: ModelDeclarationFinding[] = [];

  for (const declaration of input.declarations) {
    const expected = expectedModelDeclaration(declaration);
    if (declaration.value === expected) continue;
    findings.push({
      check: declaration.surface,
      path: declaration.path,
      field: declaration.field,
      actual: declaration.value,
      expected,
    });
  }

  for (const membership of input.memberships) {
    if (membership.values.includes(membership.value)) continue;
    findings.push({
      check: "settings.availableModels",
      path: membership.path,
      field: membership.field,
      actual: JSON.stringify(membership.values),
      expected: `contains ${JSON.stringify(membership.value)}`,
    });
  }

  for (const mapping of input.behaviorMappings) {
    if (!canonicalModelId(mapping.model).startsWith("gpt-5.6-")) continue;
    findings.push({
      check: "settings.modelPicker.behavesAs",
      path: mapping.path,
      field: mapping.field,
      actual: mapping.behavesAs,
      expected: "omitted so the 921K launcher context applies",
    });
  }

  return { findings };
}

export function renderModelDeclarationsReport(report: ModelDeclarationsReport): string {
  const lines = ["Model declaration drift"];
  for (const finding of report.findings) {
    lines.push(`  DRIFT ${finding.check.padEnd(26)} ${finding.path} ${finding.field}`);
    lines.push(`        actual: ${JSON.stringify(finding.actual)}`);
    lines.push(`      expected: ${JSON.stringify(finding.expected)}`);
  }
  lines.push(
    report.findings.length === 0
      ? "OK - model declarations match their context windows."
      : `${report.findings.length} drift finding(s). Nothing was changed.`,
  );
  return lines.join("\n");
}

export function modelDeclarationsExitCode(report: ModelDeclarationsReport): number {
  return report.findings.length === 0 ? 0 : 1;
}
