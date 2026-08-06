import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { CatalogueAuthority } from "./authority.ts";
import type { RootSessionQuery } from "./protocol.ts";

const roots: string[] = [];
const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174001";
const UUID_AUX = "323e4567-e89b-42d3-a456-426614174002";

interface Fixture {
  readonly root: string;
  readonly store: string;
  readonly cwdA: string;
  readonly cwdB: string;
  readonly fileA: string;
  readonly fileB: string;
  readonly cataloguePath: string;
  readonly authority: CatalogueAuthority;
  advance(ms: number): void;
}

function config(store: string): Config {
  return {
    store: { path: store },
    host: { label: "test-host" },
    resume: { target: "auto" },
    routing: { registry: "", hosts: "", launchers: "" },
    launcher: [],
    inference: {
      engine: "auto",
      codex: { binary: "missing-codex", model: "", reasoningEffort: "low" },
      claude: { binary: "missing-claude", model: "haiku" },
    },
    titler: { concurrency: 1, maxAttempts: 1 },
  };
}

function transcript(
  sessionId: string,
  cwd: string,
  title: string,
  timestamp: string,
  sidechain = false,
  nativeTitle = false,
): string {
  const user = `${JSON.stringify({
    type: "user",
    uuid: `${sessionId}-user`,
    sessionId,
    cwd,
    timestamp,
    isSidechain: sidechain,
    message: { role: "user", content: title },
  })}\n`;
  return nativeTitle ? `${user}${JSON.stringify({ type: "ai-title", aiTitle: title })}\n` : user;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ccs-catalogue-authority-"));
  roots.push(root);
  const store = join(root, "claude", "projects");
  const project = join(store, "project");
  const cwdA = join(root, "workspace-a");
  const cwdB = join(root, "workspace-b");
  const cache = join(root, "cache");
  mkdirSync(project, { recursive: true });
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
  mkdirSync(cache, { recursive: true });
  const fileA = join(project, `${UUID_A}.jsonl`);
  const fileB = join(project, `${UUID_B}.jsonl`);
  writeFileSync(fileA, transcript(UUID_A, cwdA, "Older root marker", "2026-07-20T10:00:00.000Z"));
  writeFileSync(fileB, transcript(UUID_B, cwdB, "Newest root marker", "2026-07-21T10:00:00.000Z", false, true));

  const auxiliaryPath = join(project, `${UUID_AUX}.jsonl`);
  writeFileSync(auxiliaryPath, transcript(UUID_AUX, cwdA, "Auxiliary marker", "2026-07-22T10:00:00.000Z"));
  const subagents = join(project, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(
    join(subagents, "agent-test.jsonl"),
    transcript(UUID_A, cwdA, "Subagent marker", "2026-07-22T11:00:00.000Z", true),
  );

  const cataloguePath = join(cache, "catalogue.db");
  const catalogue = openCatalogue(cataloguePath);
  catalogue
    .query("INSERT INTO catalogue (session_id, session_class, updated_at) VALUES ($id, 'auxiliary', $now)")
    .run({ $id: UUID_AUX, $now: "2026-07-22T12:00:00.000Z" });
  catalogue.close();

  let now = Date.parse("2026-07-22T12:00:00.000Z");
  const authority = new CatalogueAuthority({
    indexPath: join(cache, "index.db"),
    cataloguePath,
    config: config(store),
    freshMs: 1_000,
    now: () => now,
  });
  return {
    root,
    store,
    cwdA,
    cwdB,
    fileA,
    fileB,
    cataloguePath,
    authority,
    advance(ms: number): void {
      now += ms;
    },
  };
}

function query(overrides: Partial<RootSessionQuery> = {}): RootSessionQuery {
  return {
    activityWindow: "all",
    sort: "nativeActivity",
    limit: 50,
    freshness: "require-fresh",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CatalogueAuthority", () => {
  test("serves root-only filtered keyset pages without transcript content", async () => {
    const f = fixture();
    try {
      const first = await f.authority.query(query({ limit: 1 }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.sessions).toHaveLength(1);
      expect(first.value.sessions[0]).toMatchObject({
        nativeSessionId: UUID_B,
        sourceCwd: f.cwdB,
        title: "Newest root marker",
      });
      expect(first.value.sourceStatus).toMatchObject({
        generation: 1,
        freshness: "fresh",
        rowCount: 2,
      });
      expect(first.value.nextCursor).not.toBeNull();
      expect("sourcePath" in first.value.sessions[0]!).toBe(false);
      expect("skeleton" in first.value.sessions[0]!).toBe(false);

      const second = await f.authority.query(query({ limit: 1, cursor: first.value.nextCursor! }));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.sessions.map((row) => row.nativeSessionId)).toEqual([UUID_A]);
      expect(second.value.sessions[0]?.title).toBe("Claude session 123e4567");
      expect(second.value.sessions[0]?.title).not.toContain("Older root marker");
      expect(second.value.nextCursor).toBeNull();

      const filtered = await f.authority.query(query({ cwd: f.cwdA, query: "123e4567" }));
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) return;
      expect(filtered.value.sessions.map((row) => row.nativeSessionId)).toEqual([UUID_A]);
    } finally {
      await f.authority.close();
    }
  });

  test("returns one stale snapshot before scheduling background revalidation", async () => {
    const f = fixture();
    try {
      const initial = await f.authority.query(query({ limit: 1 }));
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      appendFileSync(
        f.fileB,
        transcript(UUID_B, f.cwdB, "Later private turn", "2026-07-22T14:00:00.000Z"),
      );
      f.advance(2_000);

      const stale = await f.authority.query(query({ limit: 1, freshness: "allow-stale" }));
      expect(stale.ok).toBe(true);
      if (!stale.ok) return;
      expect(stale.value.sourceStatus).toMatchObject({ generation: 1, freshness: "stale", phase: "refreshing" });
      expect(stale.value.sessions[0]?.latestActivityAt).toBe("2026-07-21T10:00:00.000Z");

      const refreshed = await f.authority.controlRefresh({ force: false, titles: false });
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;
      expect(refreshed.value.sourceStatus.generation).toBe(2);
    } finally {
      await f.authority.close();
    }
  });

  test("keeps generation stable for unchanged refreshes and invalidates cursors on source change", async () => {
    const f = fixture();
    try {
      const first = await f.authority.query(query({ limit: 1 }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const cursor = first.value.nextCursor!;

      f.advance(2_000);
      const unchanged = await f.authority.controlRefresh({ force: true, titles: false });
      expect(unchanged.ok).toBe(true);
      if (!unchanged.ok) return;
      expect(unchanged.value.sourceStatus.generation).toBe(1);
      expect(unchanged.value.stats.parsed).toBe(0);
      expect(unchanged.value.sourceStatus.freshness).toBe("fresh");

      appendFileSync(
        f.fileA,
        transcript(UUID_A, f.cwdA, "A newer turn", "2026-07-22T13:00:00.000Z"),
      );
      f.advance(2_000);
      const changed = await f.authority.controlRefresh({ force: true, titles: false });
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      expect(changed.value.sourceStatus.generation).toBe(2);
      expect(changed.value.stats.parsed).toBe(1);

      const stalePage = await f.authority.query(query({ limit: 1, cursor }));
      expect(stalePage).toEqual({
        ok: false,
        error: {
          code: "stale_cursor",
          message: "The catalogue changed or the query filters differ; restart from the first page.",
        },
      });
    } finally {
      await f.authority.close();
    }
  });

  test("non-forced refresh publishes external catalogue visibility changes while fresh", async () => {
    const f = fixture();
    try {
      const initial = await f.authority.query(query());
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      expect(initial.value.sourceStatus).toMatchObject({ generation: 1, rowCount: 2 });

      const catalogue = openCatalogue(f.cataloguePath);
      catalogue
        .query(
          "INSERT INTO catalogue (session_id, session_class, updated_at) VALUES ($id, 'auxiliary', $now)",
        )
        .run({ $id: UUID_A, $now: "2026-07-22T12:01:00.000Z" });
      catalogue.close();

      const refreshed = await f.authority.controlRefresh({ force: false, titles: false });
      expect(refreshed.ok).toBe(true);
      if (!refreshed.ok) return;
      expect(refreshed.value.sourceStatus).toMatchObject({ generation: 2, rowCount: 1 });
    } finally {
      await f.authority.close();
    }
  });

  test("authority-owned title writes advance the query generation", async () => {
    const f = fixture();
    try {
      const initial = await f.authority.query(query());
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      const saved = await f.authority.saveTitle(UUID_A, "Generated metadata title");
      expect(saved.ok).toBe(true);
      const updated = await f.authority.query(query({ query: "generated metadata" }));
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      expect(updated.value.sourceStatus.generation).toBe(initial.value.sourceStatus.generation + 1);
      expect(updated.value.sessions[0]?.title).toBe("Generated metadata title");
    } finally {
      await f.authority.close();
    }
  });

  test("does not drop a stronger title refresh behind an in-flight source refresh", async () => {
    const f = fixture();
    try {
      const sourceRefresh = f.authority.refresh({ force: true, titles: false });
      const titleRefresh = f.authority.controlRefresh({ force: true, titles: true });
      const [sourceResult, titleResult] = await Promise.all([sourceRefresh, titleRefresh]);
      expect(sourceResult.ok).toBe(true);
      expect(titleResult.ok).toBe(true);
      if (!titleResult.ok) return;
      expect(titleResult.value.titles).toEqual({
        generated: 0,
        failed: 0,
        skippedUnavailable: true,
      });
    } finally {
      await f.authority.close();
    }
  });

  test("looks up a canonical source only for a verified resume id and CWD", async () => {
    const f = fixture();
    try {
      const found = await f.authority.lookup(UUID_A, f.cwdA);
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.source).toMatchObject({
        nativeSessionId: UUID_A,
        sourceCwd: realpathSync(f.cwdA),
        sourcePath: realpathSync(f.fileA),
      });
      expect(found.value.source.fileIdentity).toMatch(/^\d+:\d+$/);

      const wrongCwd = await f.authority.lookup(UUID_A, f.cwdB);
      expect(wrongCwd).toEqual({
        ok: false,
        error: {
          code: "cwd_mismatch",
          message: "Requested CWD does not match the native Claude source.",
        },
      });

      const invalidId = await f.authority.lookup("not-a-uuid", f.cwdA);
      expect(invalidId).toEqual({
        ok: false,
        error: { code: "invalid_resume_id", message: "Native Claude resume id must be a UUID." },
      });
    } finally {
      await f.authority.close();
    }
  });
});
