/**
 * `ccs doctor categories` — is the eleven-category contract still true everywhere?
 *
 * WHY. The category rollout made every surface correct by hand, then nothing watched them.
 * Inside a single session three failures accumulated unnoticed: 47 calendar events kept
 * collecting time under retired label names while their live equivalents read near zero,
 * sixteen project briefs held entity metadata the taxonomy forbids, and the mindmap's
 * category mode sat merged and undeployed for days while every task said shipped. Each was
 * found by a human looking, which does not scale past the day someone stops looking.
 *
 * REPORT, NOT CLASSIFY. Deciding what category something belongs to is a purpose judgment,
 * and this system's confident guesses have been wrong often enough to matter — a keyword
 * rule sent 76 event commutes to Social because their titles said "Travel". So findings that
 * need a decision are reported and left alone. The one exception is a value that is purely
 * derived from a category already declared elsewhere, where the fix is a registry lookup
 * rather than an opinion; those are marked repairable.
 */
import type { Result } from "../result.ts";

export type CategoryArea = "contract" | "locations" | "deployment" | "vault" | "todoist" | "calendar";

export type CategorySeverity = "ok" | "warn" | "drift";

export interface CategoryFinding {
  /** Stable machine-readable id, so a caller can act on one finding without parsing prose. */
  readonly check: string;
  readonly area: CategoryArea;
  readonly severity: CategorySeverity;
  readonly detail: string;
  /** The command that resolves it; null when the fix is a judgment rather than a step. */
  readonly remedy: string | null;
  /** True when fixing needs no classification — a derived value whose category is declared. */
  readonly repairable: boolean;
}

export interface CategoryHealthReport {
  readonly findings: readonly CategoryFinding[];
  readonly drifted: number;
  readonly warned: number;
  /** Areas that could not be checked at all, which is distinct from an area being clean. */
  readonly unreachable: readonly string[];
}

/** A registered launch location, reduced to what this check cares about. */
export interface LocationMarker {
  readonly key: string;
  readonly status: string;
  readonly hasCategory: boolean;
  readonly category: string | null;
}

/** A deployed service compared against its origin. */
export interface DeploymentState {
  readonly name: string;
  readonly host: string;
  /** Commits behind its origin default branch; null when it could not be read. */
  readonly behind: number | null;
  readonly error: string | null;
}

export function finding(
  check: string,
  area: CategoryArea,
  severity: CategorySeverity,
  detail: string,
  options: { remedy?: string | null; repairable?: boolean } = {},
): CategoryFinding {
  return {
    check,
    area,
    severity,
    detail,
    remedy: options.remedy ?? null,
    repairable: options.repairable ?? false,
  };
}

/**
 * Every active location must carry a category or an explicit neutral marker. A retired
 * location is exempt: it routes nothing, so an unmarked one cannot misclassify a birth.
 */
export function checkLocationMarkers(locations: readonly LocationMarker[]): CategoryFinding[] {
  const unmarked = locations.filter((location) => location.status === "active" && !location.hasCategory);
  if (unmarked.length === 0) return [];
  const names = unmarked.map((location) => location.key).join(", ");
  return [
    finding(
      "locations.markers",
      "locations",
      "drift",
      `${unmarked.length} active location(s) carry no category marker: ${names}`,
      { remedy: "add `category = \"<slug>\"` or `category_neutral = true` to each in locations.toml" },
    ),
  ];
}

/** An unknown slug on a location is worse than a missing one: it routes births into nothing. */
export function checkLocationSlugs(
  locations: readonly LocationMarker[],
  slugs: ReadonlySet<string>,
): CategoryFinding[] {
  return locations
    .filter((location) => location.category !== null && !slugs.has(location.category))
    .map((location) =>
      finding(
        "locations.slug",
        "locations",
        "drift",
        `location '${location.key}' uses unknown slug '${location.category}'`,
        { remedy: "correct the slug against ClaudeConfig/categories/registry.json" },
      ),
    );
}

/**
 * A service running behind its origin is the failure that made correct work invisible: the
 * mindmap served a build with no category support at all while every task read complete.
 */
export function checkDeployments(states: readonly DeploymentState[]): CategoryFinding[] {
  const findings: CategoryFinding[] = [];
  for (const state of states) {
    if (state.error !== null) {
      findings.push(
        finding("deployment.unreadable", "deployment", "warn", `${state.name}: ${state.error}`),
      );
      continue;
    }
    if (state.behind !== null && state.behind > 0) {
      findings.push(
        finding(
          "deployment.behind",
          "deployment",
          "drift",
          `${state.name} on ${state.host} is ${state.behind} commit(s) behind origin`,
          { remedy: `deploy ${state.name}: git pull, then restart the service` },
        ),
      );
    }
  }
  return findings;
}

/** Registry and its human source of record must agree, or every consumer inherits the split. */
export function checkContract(validate: Result<void, Error>): CategoryFinding[] {
  if (validate.ok) return [];
  return [
    finding("contract.registry", "contract", "drift", validate.error.message, {
      remedy: "reconcile Life Domains.md and ClaudeConfig/categories/registry.json",
    }),
  ];
}

export function buildCategoryHealthReport(
  findings: readonly CategoryFinding[],
  unreachable: readonly string[],
): CategoryHealthReport {
  return {
    findings,
    drifted: findings.filter((item) => item.severity === "drift").length,
    warned: findings.filter((item) => item.severity === "warn").length,
    unreachable,
  };
}

/** 0 clean, 1 drift found, 2 an area could not be checked at all. */
export function categoryHealthExitCode(report: CategoryHealthReport): number {
  if (report.unreachable.length > 0) return 2;
  return report.drifted > 0 ? 1 : 0;
}

export function renderCategoryHealthReport(report: CategoryHealthReport): string {
  const areas: CategoryArea[] = ["contract", "locations", "vault", "todoist", "calendar", "deployment"];
  const lines: string[] = [];
  for (const area of areas) {
    const rows = report.findings.filter((item) => item.area === area);
    if (rows.length === 0) {
      lines.push(`${area.padEnd(11)}ok`);
      continue;
    }
    lines.push(`${area.padEnd(11)}${rows.length} finding(s)`);
    for (const row of rows) {
      const mark = row.repairable ? "[repairable] " : "";
      lines.push(`    ${mark}${row.detail}`);
      if (row.remedy !== null) lines.push(`      fix: ${row.remedy}`);
    }
  }
  for (const area of report.unreachable) {
    lines.push(`${area.padEnd(11)}UNREACHABLE`);
  }
  return lines.join("\n");
}
