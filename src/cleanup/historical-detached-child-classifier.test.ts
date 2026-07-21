import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyHistoricalDetachedChildren, type CandidateRootSession } from "./historical-detached-child-classifier.ts";

interface Fixture {
  readonly parentPath: string;
  readonly candidatePath: string;
  readonly cleanup: () => void;
}

function fixture(parentCommands: readonly string[], candidatePrompt: string, candidateTimestamp = "2026-07-15T12:00:30.000Z"): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ccs-cleanup-"));
  const parentPath = join(directory, "parent.jsonl");
  const candidatePath = join(directory, "child.jsonl");
  const parentLines = parentCommands.map((command, index) => ({
    type: "assistant",
    sessionId: "parent-1",
    cwd: "/repo",
    timestamp: `2026-07-15T12:00:${String(index).padStart(2, "0")}.000Z`,
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  }));
  writeFileSync(parentPath, parentLines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  writeFileSync(candidatePath, JSON.stringify({
    type: "user",
    cwd: "/repo",
    timestamp: candidateTimestamp,
    message: { content: candidatePrompt },
  }) + "\n" + JSON.stringify({
    type: "assistant",
    timestamp: candidateTimestamp,
    message: { model: "gpt-5.6-terra", content: [{ type: "text", text: "done" }] },
  }) + "\n");
  return { parentPath, candidatePath, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function candidate(path: string, overrides: Partial<CandidateRootSession> = {}): CandidateRootSession {
  return {
    sessionId: "child-1",
    transcriptPath: path,
    cwd: "/repo",
    entrypoint: "sdk-cli",
    provider: "gpt",
    model: "gpt-5.6-terra",
    startedAt: "2026-07-15T12:00:30.000Z",
    ...overrides,
  };
}

async function report(parentPath: string, candidates: readonly CandidateRootSession[]) {
  const result = await classifyHistoricalDetachedChildren({ parentTranscriptPaths: [parentPath], candidates });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

test("proposes an exact one-to-one detached child match", async () => {
  const files = fixture(["claude-gpt -p 'Implement the parser' --model gpt-5.6-terra"], "Implement the parser");
  const manifest = await report(files.parentPath, [candidate(files.candidatePath)]);
  files.cleanup();

  const finding = manifest.findings[0]!;
  expect(manifest.mode).toBe("report_only");
  expect(finding.status).toBe("proposed");
  expect(finding.proposal).toMatchObject({ sessionClass: "auxiliary", causalParentSessionId: "parent-1" });
  expect(finding.proposal?.tags).toEqual(["historical-cleanup", "detached-child", "auxiliary"]);
  expect(finding.evidence.matchedDimensions).toEqual(["prompt", "cwd", "entrypoint", "provider", "model", "timestamp"]);
});

test("marks more than one exact candidate as ambiguous", async () => {
  const files = fixture(["claude-gpt -p 'Same prompt' --model gpt-5.6-terra"], "Same prompt");
  const second = candidate(files.candidatePath, { sessionId: "child-2" });
  const manifest = await report(files.parentPath, [candidate(files.candidatePath), second]);
  files.cleanup();

  expect(manifest.findings[0]?.status).toBe("ambiguous");
  expect(manifest.findings[0]?.candidateSessionIds).toEqual(["child-1", "child-2"]);
});

test("marks a candidate claimed by two launches as a duplicate claim", async () => {
  const files = fixture([
    "claude-gpt -p 'Same prompt' --model gpt-5.6-terra",
    "claude-gpt -p 'Same prompt' --model gpt-5.6-terra",
  ], "Same prompt");
  const manifest = await report(files.parentPath, [candidate(files.candidatePath)]);
  files.cleanup();

  expect(manifest.findings.map((finding) => finding.status)).toEqual(["duplicate_claim", "duplicate_claim"]);
});

test("reports a real launch with no matching root transcript as unmatched", async () => {
  const files = fixture(["claude-gpt -p 'Missing child' --model gpt-5.6-terra"], "Other prompt");
  const manifest = await report(files.parentPath, [candidate(files.candidatePath)]);
  files.cleanup();

  expect(manifest.findings[0]).toMatchObject({ status: "unmatched", reason: "no candidate has the exact launch prompt" });
});

test("excludes inspection and polling commands that mention nested launch syntax", async () => {
  const files = fixture([
    "ps aux | grep 'claude-gpt -p'",
    "pgrep -af claude-gpt",
    "while pgrep -f claude-gpt; do sleep 1; done",
    "tail -f session.log | rg 'claude-native -p'",
  ], "irrelevant");
  const manifest = await report(files.parentPath, [candidate(files.candidatePath)]);
  files.cleanup();

  expect(manifest.findings).toEqual([]);
});

test("rejects exact-prompt candidates that mismatch cwd, provider, entrypoint, model, or timestamp", async () => {
  const cwdFiles = fixture(["claude-gpt -p 'Dimension check' --model gpt-5.6-terra"], "Dimension check");
  const cwd = await report(cwdFiles.parentPath, [candidate(cwdFiles.candidatePath, { cwd: "/other" })]);
  expect(cwd.findings[0]?.reason).toBe("cwd mismatch");
  cwdFiles.cleanup();

  const providerFiles = fixture(["claude-gpt -p 'Dimension check' --model gpt-5.6-terra"], "Dimension check");
  const provider = await report(providerFiles.parentPath, [candidate(providerFiles.candidatePath, { provider: "claude" })]);
  expect(provider.findings[0]?.reason).toBe("provider mismatch");
  providerFiles.cleanup();

  const entrypointFiles = fixture(["claude-gpt -p 'Dimension check' --model gpt-5.6-terra"], "Dimension check");
  const entrypoint = await report(entrypointFiles.parentPath, [candidate(entrypointFiles.candidatePath, { entrypoint: "terminal" })]);
  expect(entrypoint.findings[0]?.reason).toBe("entrypoint mismatch");
  entrypointFiles.cleanup();

  const modelFiles = fixture(["claude-gpt -p 'Dimension check' --model gpt-5.6-terra"], "Dimension check");
  const model = await report(modelFiles.parentPath, [candidate(modelFiles.candidatePath, { model: "gpt-5.6-sol" })]);
  expect(model.findings[0]?.reason).toBe("model mismatch");
  modelFiles.cleanup();

  const timestampFiles = fixture(["claude-gpt -p 'Dimension check' --model gpt-5.6-terra"], "Dimension check");
  const timestamp = await report(timestampFiles.parentPath, [candidate(timestampFiles.candidatePath, { startedAt: "2026-07-15T12:10:00.000Z" })]);
  expect(timestamp.findings[0]?.reason).toBe("timestamp outside narrow window");
  timestampFiles.cleanup();
});

test("accepts native and plain claude print-mode launches with a preceding cd", async () => {
  const files = fixture(["cd /repo && claude-native -p 'Native task' -m claude-opus-4-8"], "Native task");
  const manifest = await report(files.parentPath, [candidate(files.candidatePath, { provider: "claude", model: "claude-opus-4-8" })]);
  files.cleanup();

  expect(manifest.findings[0]?.status).toBe("proposed");
});

test("emits a deterministic manifest regardless of caller candidate order", async () => {
  const files = fixture(["claude-gpt -p 'Stable output' --model gpt-5.6-terra"], "Stable output");
  const first = candidate(files.candidatePath);
  const second = candidate(files.candidatePath, { sessionId: "child-2" });
  const one = await report(files.parentPath, [second, first]);
  const two = await report(files.parentPath, [first, second]);
  files.cleanup();

  expect(JSON.stringify(one)).toBe(JSON.stringify(two));
});

test("has no catalogue mutation architecture", async () => {
  const files = fixture(["claude-gpt -p 'Read only' --model gpt-5.6-terra"], "Read only");
  const original = readFileSync(files.candidatePath, "utf8");
  await report(files.parentPath, [candidate(files.candidatePath)]);
  expect(readFileSync(files.candidatePath, "utf8")).toBe(original);
  const source = readFileSync(new URL("./historical-detached-child-classifier.ts", import.meta.url), "utf8");
  files.cleanup();

  expect(source).not.toContain("catalogue/");
  expect(source).not.toContain("writeFile");
  expect(source).not.toContain("unlink(");
});
