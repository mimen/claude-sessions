import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { err, ok, type Result } from "../result.ts";

/** A root transcript that may correspond to one detached print-mode child launch. */
export interface CandidateRootSession {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string | null;
  readonly entrypoint: string | null;
  readonly provider: "claude" | "gpt" | null;
  readonly model: string | null;
  /** Catalogue launch time, when available. */
  readonly startedAt: string | null;
}

export interface HistoricalDetachedChildInput {
  readonly parentTranscriptPaths: readonly string[];
  readonly candidates: readonly CandidateRootSession[];
  /** Defaults to five minutes. Kept deliberately narrow to avoid speculative links. */
  readonly timestampWindowMs?: number;
}

export type HistoricalDetachedChildError =
  | { readonly kind: "read_failed"; readonly path: string }
  | { readonly kind: "invalid_input"; readonly message: string };

export type MatchStatus = "proposed" | "ambiguous" | "duplicate_claim" | "unmatched";

export interface CleanupEvidence {
  readonly promptHash: string;
  readonly parentTranscriptPath: string;
  readonly parentLine: number;
  readonly launchTimestamp: string | null;
  readonly candidateTranscriptPath: string | null;
  readonly candidateTimestamp: string | null;
  readonly matchedDimensions: readonly ("prompt" | "cwd" | "entrypoint" | "provider" | "model" | "timestamp")[];
}

export interface HistoricalDetachedChildFinding {
  readonly status: MatchStatus;
  readonly reason: string | null;
  readonly parentSessionId: string | null;
  readonly candidateSessionIds: readonly string[];
  readonly proposal: {
    readonly sessionClass: "auxiliary";
    readonly causalParentSessionId: string;
    readonly tags: readonly string[];
    readonly provenance: CleanupEvidence;
  } | null;
  readonly evidence: CleanupEvidence;
}

/** Deterministic, read-only output for a separately reviewed cleanup operation. */
export interface HistoricalDetachedChildManifest {
  readonly version: 1;
  readonly mode: "report_only";
  readonly findings: readonly HistoricalDetachedChildFinding[];
}

type Provider = "claude" | "gpt";

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue;
}

interface Launch {
  readonly parentTranscriptPath: string;
  readonly parentSessionId: string | null;
  readonly line: number;
  readonly timestamp: string | null;
  readonly cwd: string | null;
  readonly provider: Provider;
  readonly model: string | null;
  readonly prompt: string;
  readonly promptHash: string;
}

interface ParsedCandidate {
  readonly candidate: CandidateRootSession;
  readonly prompt: string | null;
  readonly cwd: string | null;
  readonly timestamp: string | null;
  readonly models: readonly string[];
}

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const AUXILIARY_TAGS = ["historical-cleanup", "detached-child", "auxiliary"] as const;

/**
 * Classifies historical nested Claude print-mode launches without touching the catalogue.
 * Every filesystem failure is returned as a Result error; malformed JSONL lines are ignored.
 */
export async function classifyHistoricalDetachedChildren(
  input: HistoricalDetachedChildInput,
): Promise<Result<HistoricalDetachedChildManifest, HistoricalDetachedChildError>> {
  if (!Number.isFinite(input.timestampWindowMs ?? DEFAULT_WINDOW_MS) || (input.timestampWindowMs ?? DEFAULT_WINDOW_MS) < 0) {
    return err({ kind: "invalid_input", message: "timestampWindowMs must be a non-negative finite number" });
  }

  const launchesResult = await parseParentLaunches(input.parentTranscriptPaths);
  if (!launchesResult.ok) return launchesResult;
  const candidatesResult = await parseCandidates(input.candidates);
  if (!candidatesResult.ok) return candidatesResult;

  const launches = launchesResult.value.slice().sort(compareLaunches);
  const candidates = candidatesResult.value.slice().sort((left, right) => left.candidate.sessionId.localeCompare(right.candidate.sessionId));
  const windowMs = input.timestampWindowMs ?? DEFAULT_WINDOW_MS;
  const compatible = new Map<Launch, ParsedCandidate[]>();
  const claims = new Map<string, Launch[]>();

  for (const launch of launches) {
    const matches = candidates.filter((candidate) => isCompatible(launch, candidate, windowMs));
    compatible.set(launch, matches);
    for (const candidate of matches) {
      const candidateClaims = claims.get(candidate.candidate.sessionId) ?? [];
      candidateClaims.push(launch);
      claims.set(candidate.candidate.sessionId, candidateClaims);
    }
  }

  const findings = launches.map((launch) => makeFinding(launch, compatible.get(launch) ?? [], claims, candidates, windowMs));
  return ok({ version: 1, mode: "report_only", findings });
}

async function parseParentLaunches(paths: readonly string[]): Promise<Result<Launch[], HistoricalDetachedChildError>> {
  const launches: Launch[] = [];
  for (const path of paths.slice().sort()) {
    const textResult = await readText(path);
    if (!textResult.ok) return textResult;
    const lines = textResult.value.split(/\r?\n/);
    let parentSessionId: string | null = null;
    let cwd: string | null = null;
    for (let index = 0; index < lines.length; index++) {
      const parsed = parseJsonObject(lines[index] ?? "");
      if (parsed === null) continue;
      parentSessionId ??= stringField(parsed, "sessionId");
      cwd ??= stringField(parsed, "cwd");
      const timestamp = stringField(parsed, "timestamp");
      for (const command of bashCommands(parsed)) {
        const launch = parseLaunch(command);
        if (launch === null) continue;
        launches.push({
          ...launch,
          parentTranscriptPath: path,
          parentSessionId,
          line: index + 1,
          timestamp,
          cwd: launch.cwd ?? cwd,
        });
      }
    }
  }
  return ok(launches);
}

async function parseCandidates(candidates: readonly CandidateRootSession[]): Promise<Result<ParsedCandidate[], HistoricalDetachedChildError>> {
  const parsed: ParsedCandidate[] = [];
  for (const candidate of candidates) {
    const textResult = await readText(candidate.transcriptPath);
    if (!textResult.ok) return textResult;
    let transcriptCwd: string | null = null;
    let firstTimestamp: string | null = null;
    let prompt: string | null = null;
    const models: string[] = [];
    for (const line of textResult.value.split(/\r?\n/)) {
      const object = parseJsonObject(line);
      if (object === null) continue;
      transcriptCwd ??= stringField(object, "cwd");
      firstTimestamp ??= stringField(object, "timestamp");
      if (prompt === null && stringField(object, "type") === "user") {
        prompt = textContent(objectValue(object, "message"));
      }
      const message = asObject(objectValue(object, "message"));
      const model = stringField(message, "model");
      if (model !== null && !models.includes(model)) models.push(model);
    }
    parsed.push({
      candidate,
      prompt,
      cwd: candidate.cwd ?? transcriptCwd,
      timestamp: candidate.startedAt ?? firstTimestamp,
      models: models.sort(),
    });
  }
  return ok(parsed);
}

function makeFinding(
  launch: Launch,
  matches: readonly ParsedCandidate[],
  claims: ReadonlyMap<string, readonly Launch[]>,
  allCandidates: readonly ParsedCandidate[],
  windowMs: number,
): HistoricalDetachedChildFinding {
  const candidateSessionIds = matches.map((candidate) => candidate.candidate.sessionId).sort();
  const baseEvidence = evidenceFor(launch, null);
  if (matches.length === 0) {
    return { status: "unmatched", reason: unmatchedReason(launch, allCandidates, windowMs), parentSessionId: launch.parentSessionId, candidateSessionIds, proposal: null, evidence: baseEvidence };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", reason: "multiple candidates satisfy every required dimension", parentSessionId: launch.parentSessionId, candidateSessionIds, proposal: null, evidence: baseEvidence };
  }
  const candidate = matches[0]!;
  const duplicateClaims = claims.get(candidate.candidate.sessionId) ?? [];
  if (duplicateClaims.length > 1) {
    return { status: "duplicate_claim", reason: "candidate is claimed by more than one launch", parentSessionId: launch.parentSessionId, candidateSessionIds, proposal: null, evidence: evidenceFor(launch, candidate) };
  }
  if (launch.parentSessionId === null) {
    return { status: "unmatched", reason: "parent transcript has no sessionId", parentSessionId: null, candidateSessionIds, proposal: null, evidence: evidenceFor(launch, candidate) };
  }
  const evidence = evidenceFor(launch, candidate);
  return {
    status: "proposed",
    reason: null,
    parentSessionId: launch.parentSessionId,
    candidateSessionIds,
    proposal: {
      sessionClass: "auxiliary",
      causalParentSessionId: launch.parentSessionId,
      tags: AUXILIARY_TAGS,
      provenance: evidence,
    },
    evidence,
  };
}

function evidenceFor(launch: Launch, candidate: ParsedCandidate | null): CleanupEvidence {
  return {
    promptHash: launch.promptHash,
    parentTranscriptPath: launch.parentTranscriptPath,
    parentLine: launch.line,
    launchTimestamp: launch.timestamp,
    candidateTranscriptPath: candidate?.candidate.transcriptPath ?? null,
    candidateTimestamp: candidate?.timestamp ?? null,
    matchedDimensions: candidate === null ? [] : ["prompt", "cwd", "entrypoint", "provider", "model", "timestamp"],
  };
}

function unmatchedReason(launch: Launch, candidates: readonly ParsedCandidate[], windowMs: number): string {
  const samePrompt = candidates.filter((candidate) => candidate.prompt === launch.prompt);
  if (samePrompt.length === 0) return "no candidate has the exact launch prompt";
  if (!samePrompt.some((candidate) => candidate.cwd === launch.cwd)) return "cwd mismatch";
  const sameCwd = samePrompt.filter((candidate) => candidate.cwd === launch.cwd);
  if (!sameCwd.some((candidate) => candidate.candidate.entrypoint === "sdk-cli")) return "entrypoint mismatch";
  const sameEntrypoint = sameCwd.filter((candidate) => candidate.candidate.entrypoint === "sdk-cli");
  if (!sameEntrypoint.some((candidate) => candidate.candidate.provider === launch.provider)) return "provider mismatch";
  const sameProvider = sameEntrypoint.filter((candidate) => candidate.candidate.provider === launch.provider);
  if (launch.model !== null && !sameProvider.some((candidate) => modelMatches(launch.model, candidate))) return "model mismatch";
  if (!sameProvider.some((candidate) => timestampsMatch(launch.timestamp, candidate.timestamp, windowMs))) return "timestamp outside narrow window";
  return "candidate did not satisfy required match dimensions";
}

function isCompatible(launch: Launch, candidate: ParsedCandidate, windowMs: number): boolean {
  return candidate.prompt === launch.prompt
    && candidate.cwd === launch.cwd
    && candidate.candidate.entrypoint === "sdk-cli"
    && candidate.candidate.provider === launch.provider
    && modelMatches(launch.model, candidate)
    && timestampsMatch(launch.timestamp, candidate.timestamp, windowMs);
}

function modelMatches(launchModel: string | null, candidate: ParsedCandidate): boolean {
  if (launchModel === null) return candidate.candidate.model !== null || candidate.models.length > 0;
  // Catalogue metadata is authoritative when present; transcript observations fill only gaps.
  return candidate.candidate.model === null
    ? candidate.models.includes(launchModel)
    : candidate.candidate.model === launchModel;
}

function timestampsMatch(left: string | null, right: string | null, windowMs: number): boolean {
  if (left === null || right === null) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return !Number.isNaN(leftMs) && !Number.isNaN(rightMs) && Math.abs(leftMs - rightMs) <= windowMs;
}

function parseLaunch(command: string): Omit<Launch, "parentTranscriptPath" | "parentSessionId" | "line" | "timestamp" | "cwd"> & { readonly cwd: string | null } | null {
  const tokens = shellTokens(command);
  if (tokens.length === 0 || isInspectionOrPolling(tokens)) return null;
  const executableIndex = tokens.findIndex((token) => token === "claude" || token === "claude-native" || token === "claude-gpt");
  const hasLeadingCd = tokens[0] === "cd" && tokens[1] !== undefined;
  if (executableIndex < 0 || (executableIndex > 1 && !(hasLeadingCd && executableIndex === 2))) return null;
  const executable = tokens[executableIndex]!;
  const promptIndex = tokens.findIndex((token, index) => index > executableIndex && (token === "-p" || token === "--print"));
  if (promptIndex < 0) return null;
  const prompt = tokens[promptIndex + 1];
  if (prompt === undefined || prompt.length === 0) return null;
  const cwdIndex = tokens.indexOf("cd");
  const cwd = cwdIndex === 0 ? (tokens[1] ?? null) : null;
  const model = optionValue(tokens, "--model") ?? optionValue(tokens, "-m");
  const provider: Provider = executable === "claude-gpt" ? "gpt" : "claude";
  return { provider, model, prompt, promptHash: hashPrompt(prompt), cwd };
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character) || character === ";" || character === "|" || character === "&") {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

function isInspectionOrPolling(tokens: readonly string[]): boolean {
  return tokens.some((token) => ["ps", "pgrep", "grep", "rg", "tail", "sleep", "while", "until", "watch"].includes(token));
}

function optionValue(tokens: readonly string[], option: string): string | null {
  const index = tokens.indexOf(option);
  return index >= 0 ? (tokens[index + 1] ?? null) : null;
}

function bashCommands(line: JsonObject): string[] {
  if (stringField(line, "type") !== "assistant") return [];
  const message = asObject(objectValue(line, "message"));
  const content = arrayValue(message, "content");
  const commands: string[] = [];
  for (const block of content) {
    const blockObject = asObject(block);
    if (blockObject === null || stringField(blockObject, "type") !== "tool_use") continue;
    const input = asObject(objectValue(blockObject, "input"));
    const command = stringField(input, "command");
    if (command !== null) commands.push(command);
  }
  return commands;
}

function textContent(value: JsonValue | null): string | null {
  const message = asObject(value);
  if (message === null) return null;
  const content = objectValue(message, "content");
  if (typeof content === "string") return content;
  const text = arrayValue(message, "content")
    .map(asObject)
    .filter((block): block is JsonObject => block !== null && stringField(block, "type") === "text")
    .map((block) => stringField(block, "text"))
    .filter((block): block is string => block !== null)
    .join("\n");
  return text || null;
}

function parseJsonObject(line: string): JsonObject | null {
  if (!line.trim()) return null;
  try {
    return asObject(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
}

function asObject(value: JsonValue | null): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function objectValue(value: JsonObject | null, key: string): JsonValue | null {
  return value?.[key] ?? null;
}

function stringField(value: JsonObject | null, key: string): string | null {
  const field = objectValue(value, key);
  return typeof field === "string" ? field : null;
}

function arrayValue(value: JsonObject | null, key: string): readonly JsonValue[] {
  const field = objectValue(value, key);
  return Array.isArray(field) ? field : [];
}

function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

async function readText(path: string): Promise<Result<string, HistoricalDetachedChildError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch {
    return err({ kind: "read_failed", path });
  }
}

function compareLaunches(left: Launch, right: Launch): number {
  return left.parentTranscriptPath.localeCompare(right.parentTranscriptPath)
    || left.line - right.line
    || left.promptHash.localeCompare(right.promptHash);
}
