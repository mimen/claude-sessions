import { describe, expect, test } from "bun:test";
import type {
  HistoricalDetachedChildFinding,
  HistoricalDetachedChildManifest,
  MatchStatus,
} from "./historical-detached-child-classifier.ts";
import {
  classifyHistoricalDetachedChildFinding,
  projectHistoricalDetachedChildDossier,
  type HistoricalDetachedChildSessionContext,
} from "./historical-detached-child-dossier.ts";

function finding(
  status: MatchStatus,
  parentSessionId: string | null,
  candidateSessionIds: readonly string[] = [],
  reason: string | null = null,
): HistoricalDetachedChildFinding {
  const evidence = {
    promptHash: "hash-<unsafe>",
    parentTranscriptPath: "/tmp/parent.jsonl",
    parentLine: 4,
    launchTimestamp: "2026-07-12T00:00:00.000Z",
    candidateTranscriptPath: candidateSessionIds[0] === undefined ? null : "/tmp/child.jsonl",
    candidateTimestamp: candidateSessionIds[0] === undefined ? null : "2026-07-12T00:00:01.000Z",
    matchedDimensions: [] as const,
  };
  return {
    status,
    reason,
    parentSessionId,
    candidateSessionIds,
    proposal: status === "proposed" && parentSessionId !== null
      ? {
        sessionClass: "auxiliary",
        causalParentSessionId: parentSessionId,
        tags: ["historical-cleanup", "detached-child", "auxiliary"],
        provenance: evidence,
      }
      : null,
    evidence,
  };
}

function manifest(findings: readonly HistoricalDetachedChildFinding[]): HistoricalDetachedChildManifest {
  return { version: 1, mode: "report_only", findings };
}

function context(sessionId: string, aliases: readonly string[] = []): HistoricalDetachedChildSessionContext {
  return {
    sessionId,
    aliases,
    title: `Title ${sessionId}`,
    project: "project",
    branch: "main",
    cwd: "/tmp",
    lastActivityAt: "2026-07-12T00:00:00.000Z",
    selfCostUSD: 1.25,
    sessionClass: null,
    causalParentSessionId: null,
    lifecycle: "idle",
    tags: [],
  };
}

describe("historical detached-child dossier", () => {
  test("represents every finding exactly once in fixed review buckets", () => {
    const source = manifest([
      finding("proposed", "parent", ["child"]),
      finding("unmatched", "parent", [], "provider mismatch"),
      finding("unmatched", "parent", [], "no candidate has the exact launch prompt"),
      finding("unmatched", "parent", [], "model mismatch"),
      finding("duplicate_claim", "parent", ["child"]),
      finding("ambiguous", "parent", ["child", "other"]),
      finding("unmatched", "parent", [], "timestamp outside narrow window"),
      finding("unmatched", "parent", [], "entrypoint mismatch"),
    ]);
    const dossier = projectHistoricalDetachedChildDossier(source, new Map());

    expect(dossier.categories.map((group) => group.findings.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(dossier.findings.map((item) => item.findingIndex).sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(dossier.totals).toEqual({ findingCount: 8, proposalCount: 1, withheldCount: 7, rootCount: 1 });
  });

  test("does not make a withheld-only parent a proposal-tree root", () => {
    const dossier = projectHistoricalDetachedChildDossier(
      manifest([finding("unmatched", "withheld-parent", [], "provider mismatch")]),
      new Map(),
    );

    expect(dossier.proposalGraph.roots).toEqual([]);
    expect(dossier.proposalGraph.nodes.map((node) => node.id)).toEqual(["withheld-parent"]);
  });

  test("uses aliases for a causal forest and ranks dense parents deterministically", () => {
    const source = manifest([
      finding("proposed", "parent-resume", ["child-a"]),
      finding("proposed", "parent", ["child-b"]),
      finding("proposed", "parent", ["child-c"]),
      finding("proposed", "parent", ["child-d"]),
      finding("proposed", "parent", ["child-e"]),
      finding("proposed", "child-a", ["grandchild"]),
      finding("unmatched", "parent", [], "provider mismatch"),
    ]);
    const contexts = new Map<string, HistoricalDetachedChildSessionContext>([
      ["parent", context("parent", ["parent-resume"])],
      ["child-a", context("child-a")],
    ]);
    const dossier = projectHistoricalDetachedChildDossier(source, contexts);
    const parent = dossier.proposalGraph.nodes.find((node) => node.id === "parent");

    expect(dossier.proposalGraph.roots).toEqual(["parent"]);
    expect(parent?.directProposedChildCount).toBe(5);
    expect(parent?.descendantProposalCount).toBe(6);
    expect(parent?.withheldFindingCount).toBe(1);
    expect(dossier.proposalGraph.denseParents).toEqual(["parent"]);
    expect(dossier.findings[0]?.parent?.canonicalId).toBe("parent");
  });

  test("retains cycles and missing context as reviewable warnings", () => {
    const source = manifest([
      finding("proposed", "a", ["b"]),
      finding("proposed", "b", ["a"]),
    ]);
    const dossier = projectHistoricalDetachedChildDossier(source, new Map());

    expect(dossier.proposalGraph.roots).toEqual([]);
    expect(dossier.proposalGraph.disconnectedNodeIds).toEqual(["a", "b"]);
    expect(dossier.proposalGraph.cycles).toEqual([["a", "b"]]);
    expect(dossier.warnings[0]).toContain("cycle");
    expect(dossier.findings[0]?.parent?.missingContext).toBe(true);
  });

  test("does not carry a raw prompt into the display projection", () => {
    const dossier = projectHistoricalDetachedChildDossier(
      manifest([finding("proposed", "parent", ["child"])]),
      new Map(),
    );

    expect(JSON.stringify(dossier)).not.toContain("raw prompt");
    expect(JSON.stringify(dossier)).toContain("hash-<unsafe>");
  });

  test("keeps category classification explicit", () => {
    expect(classifyHistoricalDetachedChildFinding(finding("unmatched", "parent", [], "cwd mismatch"))).toBe("timestamp_or_cwd_mismatch");
    expect(classifyHistoricalDetachedChildFinding(finding("unmatched", "parent", [], "entrypoint mismatch"))).toBe("other_withheld");
  });
});
