import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openIndex } from "../index/schema.ts";
import { reindexStore } from "../index/index.ts";
import { openCatalogue, getRow, setEnrichment, recordEnrichmentFailure } from "../catalogue/db.ts";
import { enrichCandidates, sweep } from "./enrich.ts";
import { MAX_ENRICHMENT_ATTEMPTS } from "./staleness.ts";
import type { EnrichmentLocation } from "./locations.ts";
import type { Enrichment } from "../catalogue/enrichment-schema.ts";

const NOW = "2026-07-24T12:00:00.000Z";
const LOCATIONS: readonly EnrichmentLocation[] = [
  { key: "repos-ccs", name: "CCS", aliases: [], cwd: "~/Programming/Repos/claude-sessions", kind: "repo" },
];

const ANSWER = {
  summary: "A session about enrichment.",
  outstanding: "",
  recommendation: "continue",
  reason: "Still moving.",
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
      expect(stored?.summary).toBe("A session about enrichment.");
      // The stamp must be the count the summary was made against, not a later one.
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

  test("counts failures and stores nothing for them", async () => {
    const f = await fixture([{ id: "a", messages: 4 }]);
    try {
      const stats = await sweep(f.index, f.catalogue, {
        locations: LOCATIONS, keyPath: f.keyPath, fetchImpl: failFetch,
      });
      expect(stats).toEqual({ enriched: 0, failed: 1, remaining: 0 });
      expect(getRow(f.catalogue, "a")?.enrichment).toBeNull();
      expect(getRow(f.catalogue, "a")?.enrichmentAttempts).toBe(1);
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
