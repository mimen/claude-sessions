import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declineExistingSessionRecommendation,
  setExistingSessionLifecycle,
} from "./commands.ts";
import { getRow, openCatalogue } from "./db.ts";
import { getIdentity, mintIdentity } from "./identities.ts";

function fixture(name: string): { readonly directory: string; readonly path: string } {
  const directory = mkdtempSync(join(tmpdir(), `ccs-${name}-`));
  return { directory, path: join(directory, "catalogue.db") };
}

describe("sidebar catalogue commands", () => {
  test("refuses phantom lifecycle rows and stamps existing rows", () => {
    const { directory, path } = fixture("sidebar-lifecycle-command");
    try {
      const setup = openCatalogue(path);
      setup.query("INSERT INTO catalogue (session_id, updated_at) VALUES ('known', 'old')").run();
      setup.close();

      expect(setExistingSessionLifecycle("missing", "complete", { cataloguePath: path })).toEqual({
        status: "not-found",
      });
      const changedAt = new Date("2026-08-05T18:00:00.000Z");
      expect(setExistingSessionLifecycle("known", "complete", {
        cataloguePath: path,
        now: () => changedAt,
      })).toEqual({ status: "ok", value: "completed" });

      const check = openCatalogue(path);
      try {
        expect(getRow(check, "missing")).toBeNull();
        expect(getRow(check, "known")).toMatchObject({
          completed: true,
          archived: false,
          updatedAt: changedAt.toISOString(),
        });
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("preserves archived-over-completed precedence and mirrors fleet identity lifecycle", () => {
    const { directory, path } = fixture("sidebar-identity-mirror");
    try {
      const identityKey = "sidebar:worker:task-61";
      const setup = openCatalogue(path);
      mintIdentity(setup, identityKey, { cluster: "sidebar", role: "worker" }, "2026-08-05T17:00:00.000Z");
      setup.query(
        "INSERT INTO catalogue (session_id, identity_key) VALUES ('known', $identityKey)",
      ).run({ $identityKey: identityKey });
      setup.close();

      expect(setExistingSessionLifecycle("known", "complete", { cataloguePath: path })).toEqual({
        status: "ok",
        value: "completed",
      });
      expect(setExistingSessionLifecycle("known", "archive", { cataloguePath: path })).toEqual({
        status: "ok",
        value: "archived",
      });
      expect(setExistingSessionLifecycle("known", "unarchive", { cataloguePath: path })).toEqual({
        status: "ok",
        value: "completed",
      });

      const check = openCatalogue(path);
      try {
        expect(getIdentity(check, identityKey)).toMatchObject({ completed: true, archived: false });
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("logs concrete SQLite open failures before returning unreadable outcomes", () => {
    const { directory } = fixture("sidebar-command-open-failure");
    const diagnostics: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const options = {
      cataloguePath: directory,
      ensureDataDir: (): void => {},
      logger: {
        warn(message: string, context?: Record<string, unknown>): void {
          diagnostics.push({ message, ...(context === undefined ? {} : { context }) });
        },
      },
    };
    try {
      expect(setExistingSessionLifecycle("known", "archive", options)).toEqual({
        status: "catalogue-unreadable",
      });
      expect(declineExistingSessionRecommendation("known", "archive", options)).toEqual({
        status: "catalogue-unreadable",
      });

      expect(diagnostics).toHaveLength(2);
      expect(diagnostics[0]).toMatchObject({
        message: "sidebar lifecycle catalogue mutation failed",
        context: { operation: "lifecycle", sessionId: "known", cataloguePath: directory },
      });
      expect(diagnostics[1]).toMatchObject({
        message: "sidebar recommendation catalogue mutation failed",
        context: { operation: "decline-recommendation", sessionId: "known", cataloguePath: directory },
      });
      for (const diagnostic of diagnostics) {
        expect(diagnostic.context?.error).toBe("unable to open database file");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("declines recommendations only for existing rows", () => {
    const { directory, path } = fixture("sidebar-decline-command");
    try {
      const setup = openCatalogue(path);
      setup.query("INSERT INTO catalogue (session_id) VALUES ('known')").run();
      setup.close();

      expect(declineExistingSessionRecommendation("missing", "archive", { cataloguePath: path }))
        .toEqual({ status: "not-found" });
      expect(declineExistingSessionRecommendation("known", "archive", { cataloguePath: path }))
        .toEqual({ status: "ok", value: undefined });

      const check = openCatalogue(path);
      try {
        expect(getRow(check, "missing")).toBeNull();
        expect(check.query(
          "SELECT enrichment_declined FROM catalogue WHERE session_id = 'known'",
        ).get()).toEqual({ enrichment_declined: "archive" });
      } finally {
        check.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
