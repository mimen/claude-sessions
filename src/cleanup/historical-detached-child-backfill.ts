import type {
  CleanupEvidence,
  HistoricalDetachedChildFinding,
  HistoricalDetachedChildManifest,
} from "./historical-detached-child-classifier.ts";
import { err, ok, type Result } from "../result.ts";

export const HISTORICAL_DETACHED_CHILD_BACKFILL_TAGS = [
  "historical-cleanup",
  "detached-child",
  "auxiliary",
] as const;

export const HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY = "historical_detached_child_backfill";

export interface HistoricalDetachedChildBackfillProposal {
  readonly findingIndex: number;
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly tags: readonly string[];
  readonly evidence: CleanupEvidence;
}

interface JsonObject {
  readonly [key: string]: JsonValue;
}

type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
type MatchDimension = CleanupEvidence["matchedDimensions"][number];

/**
 * Validate an untrusted historical manifest at the mutation boundary. The classifier's TypeScript
 * type is not sufficient here: `--manifest` is an operator-supplied JSON file.
 */
export function validateHistoricalDetachedChildBackfillManifest(
  value: JsonValue,
): Result<HistoricalDetachedChildManifest> {
  if (!isObject(value) || value.version !== 1 || value.mode !== "report_only" || !Array.isArray(value.findings)) {
    return err(new Error("manifest must be version 1, mode report_only, with a findings array"));
  }

  const findings: HistoricalDetachedChildFinding[] = [];
  for (const [index, rawFinding] of value.findings.entries()) {
    const parsed = validateFinding(rawFinding, index);
    if (!parsed.ok) return parsed;
    findings.push(parsed.value);
  }
  return ok({ version: 1, mode: "report_only", findings });
}

/**
 * Keep only the reviewed, structurally exact proposals. Every other report status is deliberately
 * ignored, even if a caller tries to put a proposal object beside it.
 */
export function exactHistoricalDetachedChildBackfillProposals(
  manifest: HistoricalDetachedChildManifest,
): Result<readonly HistoricalDetachedChildBackfillProposal[]> {
  const proposals: HistoricalDetachedChildBackfillProposal[] = [];
  const seenChildren = new Set<string>();

  for (const [findingIndex, finding] of manifest.findings.entries()) {
    if (finding.status !== "proposed") continue;
    const proposal = finding.proposal;
    if (proposal === null) return err(new Error(`finding ${findingIndex}: proposed status has no proposal`));
    if (finding.candidateSessionIds.length !== 1) {
      return err(new Error(`finding ${findingIndex}: exact proposal must have exactly one candidate session`));
    }
    const childSessionId = finding.candidateSessionIds[0]!;
    if (!childSessionId || !proposal.causalParentSessionId || childSessionId === proposal.causalParentSessionId) {
      return err(new Error(`finding ${findingIndex}: invalid causal child/parent identifiers`));
    }
    if (finding.parentSessionId !== proposal.causalParentSessionId) {
      return err(new Error(`finding ${findingIndex}: proposal parent differs from evidence parent`));
    }
    if (!sameEvidence(proposal.provenance, finding.evidence)) {
      return err(new Error(`finding ${findingIndex}: proposal provenance differs from finding evidence`));
    }
    if (proposal.sessionClass !== "auxiliary" || !sameStrings(proposal.tags, HISTORICAL_DETACHED_CHILD_BACKFILL_TAGS)) {
      return err(new Error(`finding ${findingIndex}: proposal is not the approved auxiliary historical tag set`));
    }
    if (seenChildren.has(childSessionId)) {
      return err(new Error(`finding ${findingIndex}: child ${childSessionId} is proposed more than once`));
    }
    seenChildren.add(childSessionId);
    proposals.push({
      findingIndex,
      childSessionId,
      parentSessionId: proposal.causalParentSessionId,
      tags: [...proposal.tags],
      evidence: proposal.provenance,
    });
  }

  if (proposals.length === 0) return err(new Error("manifest contains no exact proposed detached children"));
  return ok(proposals.sort((left, right) => left.childSessionId.localeCompare(right.childSessionId)));
}

function validateFinding(value: JsonValue, index: number): Result<HistoricalDetachedChildFinding> {
  if (!isObject(value)) return err(new Error(`finding ${index}: must be an object`));
  if (!isStatus(value.status)) return err(new Error(`finding ${index}: invalid status`));
  if (!isNullableString(value.reason) || !isNullableString(value.parentSessionId) || !isStringArray(value.candidateSessionIds)) {
    return err(new Error(`finding ${index}: invalid basic fields`));
  }
  const evidence = validateEvidence(value.evidence, `finding ${index} evidence`);
  if (!evidence.ok) return evidence;
  const proposal = validateProposal(value.proposal, `finding ${index} proposal`);
  if (!proposal.ok) return proposal;
  if (value.status === "proposed" && proposal.value === null) {
    return err(new Error(`finding ${index}: proposed status requires a proposal`));
  }
  if (value.status !== "proposed" && proposal.value !== null) {
    return err(new Error(`finding ${index}: withheld status must not carry a proposal`));
  }
  return ok({
    status: value.status,
    reason: value.reason,
    parentSessionId: value.parentSessionId,
    candidateSessionIds: [...value.candidateSessionIds],
    proposal: proposal.value,
    evidence: evidence.value,
  });
}

function validateProposal(
  value: JsonValue | undefined,
  label: string,
): Result<HistoricalDetachedChildFinding["proposal"]> {
  if (value === null) return ok(null);
  if (!isObject(value) || value.sessionClass !== "auxiliary" || typeof value.causalParentSessionId !== "string" || !isStringArray(value.tags)) {
    return err(new Error(`${label}: invalid proposal shape`));
  }
  const provenance = validateEvidence(value.provenance, `${label} provenance`);
  if (!provenance.ok) return provenance;
  return ok({
    sessionClass: "auxiliary",
    causalParentSessionId: value.causalParentSessionId,
    tags: [...value.tags],
    provenance: provenance.value,
  });
}

function validateEvidence(value: JsonValue | undefined, label: string): Result<CleanupEvidence> {
  if (!isObject(value)
    || typeof value.promptHash !== "string"
    || typeof value.parentTranscriptPath !== "string"
    || !isInteger(value.parentLine)
    || typeof value.launchTimestamp !== "string"
    || !isNullableString(value.candidateTranscriptPath)
    || !isNullableString(value.candidateTimestamp)
    || !isMatchDimensionArray(value.matchedDimensions)) {
    return err(new Error(`${label}: invalid evidence shape`));
  }
  return ok({
    promptHash: value.promptHash,
    parentTranscriptPath: value.parentTranscriptPath,
    parentLine: value.parentLine,
    launchTimestamp: value.launchTimestamp,
    candidateTranscriptPath: value.candidateTranscriptPath,
    candidateTimestamp: value.candidateTimestamp,
    matchedDimensions: [...value.matchedDimensions],
  });
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: JsonValue | undefined): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: JsonValue | undefined): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isMatchDimensionArray(value: JsonValue | undefined): value is readonly MatchDimension[] {
  return Array.isArray(value) && value.every((item) => item === "prompt" || item === "cwd" || item === "entrypoint"
    || item === "provider" || item === "model" || item === "timestamp");
}

function isInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isStatus(value: JsonValue | undefined): value is HistoricalDetachedChildFinding["status"] {
  return value === "proposed" || value === "ambiguous" || value === "duplicate_claim" || value === "unmatched";
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
}

function sameEvidence(left: CleanupEvidence, right: CleanupEvidence): boolean {
  return left.promptHash === right.promptHash
    && left.parentTranscriptPath === right.parentTranscriptPath
    && left.parentLine === right.parentLine
    && left.launchTimestamp === right.launchTimestamp
    && left.candidateTranscriptPath === right.candidateTranscriptPath
    && left.candidateTimestamp === right.candidateTimestamp
    && sameStrings(left.matchedDimensions, right.matchedDimensions);
}
