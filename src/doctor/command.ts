import { existsSync } from "node:fs";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getAll } from "../catalogue/db-queries.ts";
import { listByRecency } from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { buildSessionIntegrityReport } from "./session-integrity.ts";
import { collectLauncherDrift } from "./launcher-drift-io.ts";
import { launcherDriftExitCode, renderLauncherDriftReport } from "./launcher-drift.ts";
import { collectCategoryHealth } from "./category-health-io.ts";
import { categoryHealthExitCode, renderCategoryHealthReport } from "./category-health.ts";
import { collectModelDeclarations } from "./model-declarations-io.ts";
import { modelDeclarationsExitCode, renderModelDeclarationsReport } from "./model-declarations.ts";
import { collectLiveWindows } from "./live-window-io.ts";
import { liveWindowFindings, renderLiveWindowReport } from "./live-window.ts";

/**
 * `ccs doctor launcher` — report-only drift between what is DEPLOYED/INSTALLED and what the
 * current config declares. Never repairs: every finding names the command that fixes it.
 */
function launcherDoctor(args: readonly string[]): number {
  const report = collectLauncherDrift();
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLauncherDriftReport(report));
  return launcherDriftExitCode(report);
}

/**
 * `ccs doctor categories` — one signal for the whole category contract, so a loop, a hook
 * or a human can branch on the same check instead of each rebuilding its own.
 */
function categoryDoctor(args: readonly string[]): number {
  const report = collectCategoryHealth({ deep: args.includes("--deep") });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(renderCategoryHealthReport(report));
  return categoryHealthExitCode(report);
}

/**
 * `ccs doctor models --live [--launcher <name>] [--only <id>...]` — launch each picker model
 * headless and read the window Claude Code really accounts it at. Slow (one request per model)
 * and spends a token per model, so it is opt-in; the default `ccs doctor models` reads files only.
 */
function liveModelsDoctor(args: readonly string[]): number {
  const json = args.includes("--json");
  const launcherIndex = args.indexOf("--launcher");
  const launcher = launcherIndex >= 0 ? args[launcherIndex + 1] : undefined;
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args.slice(onlyIndex + 1).filter((arg) => !arg.startsWith("--")) : undefined;
  const result = collectLiveWindows({ launcher, only });
  if (!result.ok) {
    console.error(`ccs doctor models --live: ${result.error.message}`);
    return 2;
  }
  if (json) console.log(JSON.stringify(result.value, null, 2));
  else console.log(renderLiveWindowReport(result.value.launcher, result.value.results));
  return liveWindowFindings(result.value.results).length === 0 ? 0 : 1;
}

async function modelsDoctor(args: readonly string[]): Promise<number> {
  if (args.includes("--live")) return liveModelsDoctor(args.filter((arg) => arg !== "--live"));
  if (args.some((arg) => arg !== "--json")) {
    console.error("usage: ccs doctor models [--json] | ccs doctor models --live [--json] [--launcher <name>] [--only <id>...]");
    return 2;
  }
  const result = await collectModelDeclarations();
  if (!result.ok) {
    console.error(`ccs doctor models: ${result.error.message}`);
    return 2;
  }
  if (args.includes("--json")) console.log(JSON.stringify(result.value, null, 2));
  else console.log(renderModelDeclarationsReport(result.value));
  return modelDeclarationsExitCode(result.value);
}

export function doctorCommand(args: readonly string[]): number | Promise<number> {
  if (args[0] === "launcher") return launcherDoctor(args.slice(1));
  if (args[0] === "categories") return categoryDoctor(args.slice(1));
  if (args[0] === "models") return modelsDoctor(args.slice(1));
  if (args[0] !== "sessions") {
    console.error(
      "usage: ccs doctor sessions [--json]\n" +
        "       ccs doctor launcher [--json]\n" +
        "       ccs doctor categories [--json] [--deep]\n" +
        "       ccs doctor models [--json]\n" +
        "       ccs doctor models --live [--json] [--launcher <name>] [--only <id>...]",
    );
    return 2;
  }
  if (!existsSync(DB_PATH())) {
    console.error("ccs doctor sessions: session index is missing; run `ccs reindex` first");
    return 2;
  }

  ensureDataDir();
  const index = openIndex(DB_PATH());
  const catalogueDb = openCatalogue(CATALOGUE_PATH());
  try {
    const report = buildSessionIntegrityReport(listByRecency(index, true), getAll(catalogueDb));
    if (args.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Session birth integrity since ${report.rolloutAt}`);
      console.log(`checked=${report.checked} unclassified=${report.counts.unclassified} missing_provenance=${report.counts.missing_provenance}`);
      for (const finding of report.findings) {
        console.log(`${finding.issue.padEnd(18)} ${finding.sessionId}  ${finding.project}  ${finding.title}`);
      }
      if (report.findings.length === 0) console.log("OK — no managed-birth integrity findings.");
    }
    return report.findings.length === 0 ? 0 : 1;
  } finally {
    index.close();
    catalogueDb.close();
  }
}
