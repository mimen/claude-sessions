import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openIndex } from "../index/schema.ts";
import { reindexStore } from "../index/index.ts";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getRow } from "../catalogue/db-queries.ts";
import { setEnrichment, recordEnrichmentFailure } from "../catalogue/db-mutations.ts";
import { enrichCandidates, sweep } from "./enrich.ts";
import { MAX_ENRICHMENT_ATTEMPTS } from "./staleness.ts";
import type { EnrichmentLocation } from "./locations.ts";
import type { Enrichment } from "../catalogue/enrichment-schema.ts";

const NOW = "2026-07-24T12:00:00.000Z";
const LOCATIONS: readonly EnrichmentLocation[] = [
  { key: "repos-ccs", name: "CCS", aliases: [], cwd: "~/Programming/Repos/claude-sessions", kind: "repo" },
];

const ANSWER = {
  title: "Enrichment sweep",
  state: "A session about enrichment.",
  history: "",
  next: "Keep going",
  remaining: "",
  recommendation: "continue",
  // v40: empty for continue — reason is required only for archive, handoff, and junk.
  reason: "",
  junk: false,
  cwdCorrect: true,
  suggestedLocation: "",
  suggestedCwd: "",
};

function storedEnrichment(overrides: Partial<Enrichment> = {}): Enrichment {
  return { ...ANSWER, recommendation: "continue", atMessages: 2, at: NOW, ...overrides } as Enrichment;
}

interface Fixture {
  index: Database;
  catalogue: Database;
  dir: string;
  keyPath: string;
}

/** Build a real index from real transcript files — the sweep reads both the DB and the files. */
async function fixture(
  sessions: { id: string; messages: number; sidechain?: boolean }[],
): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "ccs-enrich-sweep-"));
  const files = sessions.map((session) => {
    const path = join(dir, `${session.id}.jsonl`);
    const lines = Array.from({ length: session.messages }, (_, i) => JSON.stringify({
      type: i % 2 === 0 ? "user" : "assistant",
      cwd: "/Users/mimen",
      isSidechain: session.sidechain ?? false,
      message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `turn ${i}` }] },
    }));
    writeFileSync(path, lines.join("\n") + "\n");
    return { path, sessionId: session.id, sizeBytes: 100, mtimeMs: 1 };
  });

  const index = openIndex(":memory:");
  await reindexStore(index, files, "test-host");
  const catalogue = openCatalogue(":memory:");
  const keyPath = join(dir, "key");
  writeFileSync(keyPath, "test-key\n");
  return { index, catalogue, dir, keyPath };
}

function teardown(f: Fixture): void {
  f.index.close();
  f.catalogue.close();
  rmSync(f.dir, { recursive: true, force: true });
}

const okFetch = async () =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", name: "answer", input: ANSWER }] }), { status: 200 });
const failFetch = async () => new Response("nope", { status: 500 });
/** A 200 carrying an answer we reject — the session's own problem, so it costs an attempt. */
const malformedFetch = async () =>
  new Response(JSON.stringify({ content: [{ type: "tool_use", name: "answer", input: { summary: "only this" } }] }), { status: 200 });
/** The real-world shape: HTTP 200 with an error envelope when a provider is cooling down. */
const rateLimitedFetch = async () =>
  new Response(JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message: "All credentials for model gpt-5.6-sol(medium) are cooling down via provider codex" },
  }), { status: 200 });

describe("enrichCandidates", () => {
  test("a cold store makes every top-level session a candidate", async () => {
    const f = await fixture([{ id: "a", messages: 4 }, { id: "b", messages: 6 }]);
    try {
      expect(enrichCandidates(f.index, f.catalogue).map((c) => c.row.sessionId).sort()).toEqual(["a", "b"]);
      expect(enrichCandidates(f.index, f.catalogue).every((c) => c.reason === "never-enriched")).toBe(true);
    } finally {
      teardown(f);
    }
  });

  test("excludes subagent transcripts", async () => {
    // You catch up on the session that delegated, not on the delegate.
    const f = await fixture([{ id: "parent", messages: 4 }, { id: "child", messages: 4, sidechain: true }]);
    try {
      expect(enrichCandidates(f.index, f.catalogue).map((c) => c.row.sessionId)).toEqual(["parent"]);
    } finally {
      teardown(f);
    }
  });

  test("excludes sessions declared auxiliary", async () => {
    const f = await fixture([{ id: "a", messages: 4 }, { id: "aux", messages: 4 }]);
    try {
      f.catalogue.query(
        "INSERT INTO catalogue (session_id, session_class, updated_at) VALUES ('aux', 'auxiliary', $now)",
      ).run({ $now: NOW });
      expect(enrichCandidates(f.index, f.catalogue).map((c) => c.row.sessionId)).toEqual(["a"]);
    } finally {
      teardown(f);
    }
  });

  test("excludes a session whose stored enrichment is still current", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    try {
      setEnrichment(f.catalogue, "a", storedEnrichment({ atMessages: 4, at: NOW }), NOW);
      expect(enrichCandidates(f.index, f.catalogue, new Date(NOW))).toEqual([]);
    } finally {
      teardown(f);
    }
  });

  test("category staleness is ORed with fresh prose and deterministic repair skips the gateway", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    const previous = process.env.CCS_CATEGORY_REGISTRY_PATH;
    const registryPath = join(f.dir, "categories.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      classifier_version: "v1",
      categories: [{ slug: "ai-systems", name: "AI Systems", compact_name: "AI", color: "#2A67E2" }],
      project_mappings: {},
      path_mappings: { "/Users/mimen": "ai-systems" },
    }));
    process.env.CCS_CATEGORY_REGISTRY_PATH = registryPath;
    try {
      setEnrichment(f.catalogue, "a", storedEnrichment({ atMessages: 4, at: NOW }), NOW);
      const candidates = enrichCandidates(f.index, f.catalogue, new Date(NOW));
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.categoryReasons).toEqual(["category-missing"]);
      let calls = 0;
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS,
        keyPath: f.keyPath,
        fetchImpl: async () => { calls++; return okFetch(); },
        now: () => new Date(NOW),
      });
      expect(stats).toEqual({ enriched: 1, failed: 0, remaining: 0 });
      expect(calls).toBe(0);
      expect(f.catalogue.query("SELECT entity FROM session_tags WHERE session_id='a'").all()).toEqual([
        { entity: "domain:ai-systems" },
      ]);
    } finally {
      if (previous === undefined) delete process.env.CCS_CATEGORY_REGISTRY_PATH;
      else process.env.CCS_CATEGORY_REGISTRY_PATH = previous;
      teardown(f);
    }
  });

  test("unresolved category fallback uses the closed registry and preserves fresh prose", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    const previous = process.env.CCS_CATEGORY_REGISTRY_PATH;
    const registryPath = join(f.dir, "categories.json");
    writeFileSync(registryPath, JSON.stringify({
      version: 1,
      classifier_version: "v1",
      categories: [{ slug: "ai-systems", name: "AI Systems", compact_name: "AI", color: "#2A67E2" }],
      project_mappings: {},
      path_mappings: {},
    }));
    process.env.CCS_CATEGORY_REGISTRY_PATH = registryPath;
    try {
      setEnrichment(f.catalogue, "a", storedEnrichment({ state: "Keep this fresh prose.", atMessages: 4, at: NOW }), NOW);
      let requestBodyText = "";
      const categoryFetch = async (_input: string | URL | Request, init?: RequestInit) => {
        requestBodyText = String(init?.body ?? "");
        return new Response(JSON.stringify({
          content: [{ type: "tool_use", name: "answer", input: { ...ANSWER, state: "Do not store this replacement.", categorySlug: "ai-systems" } }],
        }), { status: 200 });
      };
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS,
        keyPath: f.keyPath,
        fetchImpl: categoryFetch,
        now: () => new Date(NOW),
      });
      expect(stats).toEqual({ enriched: 1, failed: 0, remaining: 0 });
      const requestBody = JSON.parse(requestBodyText) as {
        tools: Array<{ input_schema: { required: string[]; properties: Record<string, { enum?: string[] }> } }>;
      };
      const tool = requestBody.tools[0]!;
      expect(tool.input_schema.required).toContain("categorySlug");
      expect(tool.input_schema.properties.categorySlug?.enum).toEqual(["ai-systems"]);
      expect(getRow(f.catalogue, "a")?.enrichment?.state).toBe("Keep this fresh prose.");
      expect(f.catalogue.query("SELECT slug, source FROM session_category_assignments WHERE session_id='a'").get())
        .toEqual({ slug: "ai-systems", source: "model" });
    } finally {
      if (previous === undefined) delete process.env.CCS_CATEGORY_REGISTRY_PATH;
      else process.env.CCS_CATEGORY_REGISTRY_PATH = previous;
      teardown(f);
    }
  });
});

describe("sweep", () => {
  test("enriches every stale session and persists the result", async () => {
    const f = await fixture([{ id: "a", messages: 4 }, { id: "b", messages: 4 }]);
    try {
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: okFetch,
      });
      expect(stats).toEqual({ enriched: 2, failed: 0, remaining: 0 });
      const stored = getRow(f.catalogue, "a")?.enrichment;
      expect(stored?.state).toBe("A session about enrichment.");
      // The stamp must be the count the state was made against, not a later one.
      expect(stored?.atMessages).toBe(4);
    } finally {
      teardown(f);
    }
  });

  test("a second sweep is a no-op — this is the whole cost model", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    try {
      await sweep(f.index, f.catalogue, { locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: okFetch });
      let calls = 0;
      const counting = async () => { calls++; return okFetch(); };
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: counting,
      });
      expect(calls).toBe(0);
      expect(stats.enriched).toBe(0);
    } finally {
      teardown(f);
    }
  });

  test("honours a limit and reports what it left behind", async () => {
    const f = await fixture([{ id: "a", messages: 4 }, { id: "b", messages: 4 }, { id: "c", messages: 4 }]);
    try {
      const stats = await sweep(f.index, f.catalogue, {
        limit: 2, locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: okFetch,
      });
      expect(stats.enriched).toBe(2);
      expect(stats.remaining).toBe(1);
    } finally {
      teardown(f);
    }
  });

  test("counts a content failure and spends the session's budget", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    try {
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: malformedFetch,
      });
      expect(stats.enriched).toBe(0);
      expect(stats.failed).toBe(1);
      expect(getRow(f.catalogue, "a")?.enrichment).toBeNull();
      // The model answered and we rejected the answer — that is this session's problem, so it
      // costs it an attempt.
      expect(getRow(f.catalogue, "a")?.enrichmentAttempts).toBe(1);
    } finally {
      teardown(f);
    }
  });

  test("a rate limit never spends a session's attempt budget", async () => {
    // The regression this exists for: one provider cooldown burnt an attempt on forty perfectly
    // enrichable sessions in a single sweep. Three such storms would have excluded them from
    // enrichment permanently, for a reason that had nothing to do with them.
    const f = await fixture([{ id: "a", messages: 4 }]);
    try {
      await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: rateLimitedFetch,
      });
      expect(getRow(f.catalogue, "a")?.enrichmentAttempts ?? 0).toBe(0);
    } finally {
      teardown(f);
    }
  });

  test("stops early instead of grinding through a dead gateway", async () => {
    const f = await fixture(Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, messages: 4 })));
    try {
      let calls = 0;
      const counting = async () => { calls++; return rateLimitedFetch(); };
      const stats = await sweep(f.index, f.catalogue, {
        concurrency: 1, locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: counting,
      });
      expect(calls).toBeLessThanOrEqual(4);
      expect(stats.abortedReason).toMatch(/cooling down|rate/i);
      // Everything unattempted is still pending, not silently dropped.
      expect(stats.remaining).toBe(20 - stats.enriched - stats.failed);
    } finally {
      teardown(f);
    }
  });

  test("an intermittent rate limit does not trip the breaker", async () => {
    const f = await fixture(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, messages: 4 })));
    try {
      let call = 0;
      // Alternating success and rate limit: the breaker counts CONSECUTIVE failures, so a busy
      // gateway that still answers must not look like a dead one.
      const flaky = async () => (++call % 2 === 0 ? rateLimitedFetch() : okFetch());
      const stats = await sweep(f.index, f.catalogue, {
        concurrency: 1, locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: flaky,
      });
      expect(stats.abortedReason).toBeUndefined();
      expect(stats.enriched).toBe(3);
    } finally {
      teardown(f);
    }
  });

  test("a session that has burnt its attempts is skipped entirely", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    try {
      for (let i = 0; i < MAX_ENRICHMENT_ATTEMPTS; i++) recordEnrichmentFailure(f.catalogue, "a", NOW);
      let calls = 0;
      const counting = async () => { calls++; return okFetch(); };
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: counting,
      });
      expect(calls).toBe(0);
      expect(stats.enriched).toBe(0);
    } finally {
      teardown(f);
    }
  });

  test("stops promptly when cancelled", async () => {
    const f = await fixture(Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, messages: 4 })));
    try {
      let calls = 0;
      const counting = async () => { calls++; return okFetch(); };
      await sweep(f.index, f.catalogue, {
        concurrency: 1,
        locations: LOCATIONS,
        keyPath: f.keyPath,
        fetchImpl: counting,
        isCancelled: () => calls >= 2,
      });
      expect(calls).toBeLessThan(8);
    } finally {
      teardown(f);
    }
  });

  test("reports progress once per completed session", async () => {
    const f = await fixture([{ id: "a", messages: 4 }, { id: "b", messages: 4 }]);
    try {
      const seen: number[] = [];
      await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: okFetch,
        onProgress: (done) => seen.push(done),
      });
      expect(seen.sort()).toEqual([1, 2]);
    } finally {
      teardown(f);
    }
  });

  test("one bad session does not stop the rest of the sweep", async () => {
    const f = await fixture([{ id: "a", messages: 4 }, { id: "b", messages: 4 }, { id: "c", messages: 4 }]);
    try {
      let call = 0;
      const flaky = async () => (++call === 1 ? failFetch() : okFetch());
      const stats = await sweep(f.index, f.catalogue, {
        concurrency: 1, locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: flaky,
      });
      expect(stats.enriched).toBe(2);
      expect(stats.failed).toBe(1);
    } finally {
      teardown(f);
    }
  });
});
