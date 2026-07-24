import type { CatalogueRow } from "../catalogue/db.ts";
import type { SessionRow } from "../index/index.ts";
import { SESSION_PROVENANCE_ROLLOUT_AT, SESSION_PROVENANCE_ROLLOUT_MS } from "../session-class.ts";

export type SessionIntegrityIssue = "unclassified" | "missing_provenance";

export interface SessionIntegrityFinding {
  readonly sessionId: string;
  readonly title: string;
  readonly project: string;
  readonly firstTs: string;
  readonly issue: SessionIntegrityIssue;
}

export interface SessionIntegrityReport {
  readonly rolloutAt: string;
  readonly checked: number;
  readonly findings: readonly SessionIntegrityFinding[];
  readonly counts: Readonly<Record<SessionIntegrityIssue, number>>;
}

export function buildSessionIntegrityReport(
  rows: readonly SessionRow[],
  catalogue: ReadonlyMap<string, CatalogueRow>,
  rolloutMs = SESSION_PROVENANCE_ROLLOUT_MS,
): SessionIntegrityReport {
  const findings: SessionIntegrityFinding[] = [];
  let checked = 0;

  for (const row of rows) {
    if (row.isSubagent || row.firstTs === null || Date.parse(row.firstTs) < rolloutMs) continue;
    checked++;
    const metadata = catalogue.get(row.sessionId);
    if (metadata?.sessionClass == null) {
      findings.push({
        sessionId: row.sessionId,
        title: row.title,
        project: row.projectName,
        firstTs: row.firstTs,
        issue: "unclassified",
      });
      continue;
    }
    const missingNonHumanRef = metadata.creatorKind !== null
      && metadata.creatorKind !== "human"
      && metadata.creatorRef == null;
    if (metadata.creatorKind == null || metadata.launchChannel == null || missingNonHumanRef) {
      findings.push({
        sessionId: row.sessionId,
        title: row.title,
        project: row.projectName,
        firstTs: row.firstTs,
        issue: "missing_provenance",
      });
    }
  }

  findings.sort((left, right) => right.firstTs.localeCompare(left.firstTs) || left.sessionId.localeCompare(right.sessionId));
  return {
    rolloutAt: new Date(rolloutMs).toISOString() === SESSION_PROVENANCE_ROLLOUT_AT
      ? SESSION_PROVENANCE_ROLLOUT_AT
      : new Date(rolloutMs).toISOString(),
    checked,
    findings,
    counts: {
      unclassified: findings.filter((finding) => finding.issue === "unclassified").length,
      missing_provenance: findings.filter((finding) => finding.issue === "missing_provenance").length,
    },
  };
}
