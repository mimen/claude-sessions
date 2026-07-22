import { existsSync } from "node:fs";
import { getAll, openCatalogue } from "../catalogue/db.ts";
import { listByRecency } from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { buildSessionIntegrityReport } from "./session-integrity.ts";

export function doctorCommand(args: readonly string[]): number {
  if (args[0] !== "sessions") {
    console.error("usage: ccs doctor sessions [--json]");
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
