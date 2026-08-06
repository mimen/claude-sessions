import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRow, lifecycleOf, openCatalogue } from "../catalogue/db.ts";
import { mintIdentity } from "../catalogue/identities.ts";
import { disagreement } from "../enrich/triage.ts";
import type { SessionRow } from "../index/index.ts";
import { readCatalogueReadOnly } from "./catalogue-read.ts";
import { projectSidebar, type IndexedSessionInput } from "./projection.ts";

function temporaryCatalogue(
  name: string,
  create: (path: string) => void,
): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), `ccs-sidebar-${name}-`));
  const path = join(root, "catalogue.db");
  create(path);
  return { root, path };
}

describe("readCatalogueReadOnly", () => {
  test("matches current lifecycle, aliases, titles, membership, auxiliary, and enrichment facts", () => {
    const fixture = temporaryCatalogue("catalogue-current", (path) => {
      const db = openCatalogue(path, { materialize: false });
      try {
        mintIdentity(
          db,
          "sidebar:worker:one",
          { cluster: "sidebar", role: "worker" },
          "2026-08-05T12:00:00.000Z",
        );
        db.query(
          `INSERT INTO catalogue
             (session_id, resume_id, custom_title, completed, identity_key, session_class,
              enrichment_title, enrichment_state, enrichment_history, enrichment_next,
              enrichment_remaining, enrichment_recommendation, enrichment_reason,
              enrichment_junk, enrichment_at_messages, enrichment_at, enrichment_declined)
           VALUES
             ('canonical', 'resume', ' Human title ', 1, 'sidebar:worker:one', 'work_body',
              'Generated title', 'Current state', 'History', 'Next action', 'Remaining',
              'archive', 'Reason', 1, 42, '2026-08-05T12:00:00.000Z', 'archive'),
             ('auxiliary', 'aux-resume', NULL, 0, NULL, 'auxiliary',
              NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL)`,
        ).run();
      } finally {
        db.close();
      }
    });

    try {
      const outcome = readCatalogueReadOnly(fixture.path);
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("current catalogue was not readable");

      expect(outcome.facts.lifecycles.get("canonical")).toBe("completed");
      expect(outcome.facts.lifecycles.get("resume")).toBe("completed");
      expect(outcome.facts.catalogueLifecycles.get("resume")).toBe("completed");
      expect(outcome.facts.canonicalSessionIds.get("resume")).toBe("canonical");
      expect(outcome.facts.preferredTitles.get("canonical")).toBe("Human title");
      expect(outcome.facts.preferredTitles.get("resume")).toBe("Human title");
      expect(outcome.facts.memberships.get("resume")).toEqual({
        identityKey: "sidebar:worker:one",
        cluster: "sidebar",
        role: "worker",
        kind: "fleet",
      });
      expect(outcome.facts.sessionIds.get("completed")).toEqual(["canonical"]);
      expect(outcome.facts.auxiliary.has("auxiliary")).toBeTrue();
      expect(outcome.facts.auxiliary.has("aux-resume")).toBeTrue();
      expect(outcome.facts.summaries.get("resume")).toEqual({
        title: "Generated title",
        state: "Current state",
        history: "History",
        next: "Next action",
        remaining: "Remaining",
        recommendation: "archive",
        reason: "Reason",
        junk: true,
        cwdCorrect: null,
        suggestedLocation: null,
        suggestedCwd: null,
        atMessages: 42,
        at: "2026-08-05T12:00:00.000Z",
        legacyShape: false,
        declined: "archive",
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("reads old additive schemas by presence, including enrichment_declined at a stale user_version", () => {
    const fixture = temporaryCatalogue("catalogue-old", (path) => {
      const db = new Database(path);
      try {
        db.exec(`
          PRAGMA user_version = 1;
          CREATE TABLE catalogue (
            session_id TEXT PRIMARY KEY,
            resume_id TEXT,
            completed INTEGER,
            enrichment_summary TEXT,
            enrichment_outstanding TEXT,
            enrichment_recommendation TEXT,
            enrichment_declined TEXT
          );
          INSERT INTO catalogue VALUES
            ('old', 'old-resume', 1, 'Legacy state', 'Legacy next', 'complete', 'complete');
        `);
      } finally {
        db.close();
      }
    });

    try {
      const outcome = readCatalogueReadOnly(fixture.path);
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("old catalogue was not readable");
      expect(outcome.facts.lifecycles.get("old-resume")).toBe("completed");
      expect(outcome.facts.summaries.get("old")).toMatchObject({
        state: "Legacy state",
        next: "Legacy next",
        recommendation: "complete",
        declined: "complete",
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps usable lifecycle facts when optional identity and enrichment schema is partial", () => {
    const fixture = temporaryCatalogue("catalogue-partial", (path) => {
      const db = new Database(path);
      try {
        db.exec(`
          CREATE TABLE catalogue (
            session_id TEXT PRIMARY KEY,
            archived INTEGER,
            identity_key TEXT,
            enrichment_state TEXT
          );
          CREATE TABLE identities (identity_key TEXT PRIMARY KEY, cluster TEXT, role TEXT);
          INSERT INTO catalogue VALUES ('partial', 1, 'partial:key', NULL);
        `);
      } finally {
        db.close();
      }
    });

    try {
      const outcome = readCatalogueReadOnly(fixture.path);
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("partial catalogue was not readable");
      expect(outcome.facts.lifecycles.get("partial")).toBe("archived");
      expect(outcome.facts.memberships.size).toBe(0);
      expect(outcome.facts.summaries.size).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("identity-only archived, completed, and parked lifecycle matches full hydration and CLI triage", () => {
    const fixture = temporaryCatalogue("identity-lifecycle", (path) => {
      const db = openCatalogue(path, { materialize: false });
      try {
        for (const [suffix, field] of [
          ["archived", "archived"],
          ["completed", "completed"],
          ["parked", "parked_task_id"],
        ] as const) {
          const identityKey = `sidebar:worker:${suffix}`;
          mintIdentity(
            db,
            identityKey,
            { cluster: "sidebar", role: "worker" },
            "2026-08-05T12:00:00.000Z",
          );
          const value = field === "parked_task_id" ? "task-1" : 1;
          db.query(`UPDATE identities SET ${field} = $value WHERE identity_key = $key`).run({
            $value: value,
            $key: identityKey,
          });
          db.query(
            `INSERT INTO catalogue
               (session_id, identity_key, enrichment_state, enrichment_recommendation, enrichment_at)
             VALUES ($id, $key, 'Observed state', $recommendation, '2026-08-05T12:00:00.000Z')`,
          ).run({
            $id: suffix,
            $key: identityKey,
            $recommendation: suffix === "completed" ? "archive" : "complete",
          });
        }
      } finally {
        db.close();
      }
    });

    try {
      const full = openCatalogue(fixture.path, { materialize: false });
      const fullRows = new Map(
        ["archived", "completed", "parked"].map((id) => [id, getRow(full, id)] as const),
      );
      full.close();
      const outcome = readCatalogueReadOnly(fixture.path);
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("identity lifecycle catalogue was not readable");

      for (const id of ["archived", "completed", "parked"] as const) {
        const fullRow = fullRows.get(id) ?? null;
        const fullLifecycle = lifecycleOf(fullRow);
        expect(outcome.facts.catalogueLifecycles.get(id)).toBe(fullLifecycle);
        const session = {
          sessionId: id,
          title: id,
          cwd: "/repo",
          msgCount: 10,
          lastTs: "2026-08-05T12:00:00.000Z",
          isSubagent: false,
        } as SessionRow;
        expect(disagreement(session, fullRow)).toBeNull();

        const browserLifecycle = outcome.facts.lifecycles.get(id) ?? "active";
        const indexed: IndexedSessionInput = {
          sessionId: id,
          resumeId: id,
          title: id,
          cwd: "/repo",
          lastTs: "2026-08-05T12:00:00.000Z",
          models: [],
          costByModel: {},
        };
        const snapshot = projectSidebar({
          live: [],
          indexed: [indexed],
          lifecycles: outcome.facts.lifecycles,
          catalogueLifecycles: outcome.facts.catalogueLifecycles,
          summaries: outcome.facts.summaries,
          checkouts: new Map(),
          scope: browserLifecycle,
          livenessReadable: true,
          now: Date.parse("2026-08-05T12:00:00.000Z"),
        });
        const sidebarRow = snapshot.rows.find((row) => row.kind === "session" && row.id === id);
        expect(sidebarRow?.kind === "session" && sidebarRow.suggestion).toBeNull();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("keeps parked distinct for decisions while preserving the three-state browser lifecycle", () => {
    const fixture = temporaryCatalogue("catalogue-parked", (path) => {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE catalogue (
          session_id TEXT PRIMARY KEY,
          resume_id TEXT,
          parked_task_id TEXT,
          enrichment_state TEXT,
          enrichment_recommendation TEXT,
          enrichment_declined TEXT
        );
        INSERT INTO catalogue VALUES
          ('parked', 'parked-resume', 'task-1', 'Waiting', 'complete', NULL),
          ('invalid', NULL, NULL, 'Readable', 'delete', 'delete');
      `);
      db.close();
    });

    try {
      const outcome = readCatalogueReadOnly(fixture.path);
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") throw new Error("parked catalogue was not readable");
      expect(outcome.facts.lifecycles.get("parked-resume")).toBe("active");
      expect(outcome.facts.catalogueLifecycles.get("parked-resume")).toBe("parked");
      expect(outcome.facts.summaries.get("invalid")).toMatchObject({
        recommendation: null,
        declined: null,
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("returns typed missing, unreadable, and unsupported-schema outcomes", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-sidebar-catalogue-outcomes-"));
    try {
      expect(readCatalogueReadOnly(join(root, "missing.db"))).toEqual({ status: "missing" });

      const unreadablePath = join(root, "unreadable.db");
      writeFileSync(unreadablePath, "not a sqlite database");
      expect(readCatalogueReadOnly(unreadablePath).status).toBe("unreadable");

      const unsupportedPath = join(root, "unsupported.db");
      const db = new Database(unsupportedPath);
      db.exec("CREATE TABLE unrelated (id TEXT)");
      db.close();
      expect(readCatalogueReadOnly(unsupportedPath)).toEqual({
        status: "unsupported-schema",
        missing: ["table:catalogue"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
