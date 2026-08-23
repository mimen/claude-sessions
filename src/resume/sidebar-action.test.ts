import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bridge } from "../cmux/bridge.ts";
import { bunAsyncProcessAdapter } from "../process/async.ts";
import { createSidebarResumeAction } from "./sidebar-action.ts";

interface Diagnostic {
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

function logger(diagnostics: Diagnostic[]): { warn(message: string, context?: Record<string, unknown>): void } {
  return {
    warn(message, context): void {
      diagnostics.push({ message, ...(context === undefined ? {} : { context }) });
    },
  };
}

const UNUSED_BRIDGE = {} as Bridge;

describe("sidebar resume action diagnostics", () => {
  test("logs the concrete index open failure before returning index-unreadable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-resume-index-"));
    const diagnostics: Diagnostic[] = [];
    try {
      const action = createSidebarResumeAction({
        processAdapter: bunAsyncProcessAdapter,
        indexPath: directory,
        cataloguePath: join(directory, "unused-catalogue.db"),
        logger: logger(diagnostics),
      });

      await expect(action({
        bridge: UNUSED_BRIDGE,
        sessionId: "session-index-failure",
        cmuxBin: "cmux",
        launchers: [],
      })).resolves.toEqual({ status: "index-unreadable" });

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        message: "sidebar resume index open failed",
        context: {
          operation: "resume",
          sessionId: "session-index-failure",
          indexPath: directory,
        },
      });
      expect(diagnostics[0]?.context?.error).toBe("unable to open database file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("logs the concrete catalogue open failure before returning catalogue-unreadable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-resume-catalogue-"));
    const indexPath = join(directory, "index.db");
    new Database(indexPath).close();
    const diagnostics: Diagnostic[] = [];
    try {
      const action = createSidebarResumeAction({
        processAdapter: bunAsyncProcessAdapter,
        indexPath,
        cataloguePath: directory,
        logger: logger(diagnostics),
      });

      await expect(action({
        bridge: UNUSED_BRIDGE,
        sessionId: "session-catalogue-failure",
        cmuxBin: "cmux",
        launchers: [],
      })).resolves.toEqual({ status: "catalogue-unreadable" });

      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        message: "sidebar resume catalogue open failed",
        context: {
          operation: "resume",
          sessionId: "session-catalogue-failure",
          cataloguePath: directory,
        },
      });
      expect(diagnostics[0]?.context?.error).toBe("unable to open database file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("sidebar resume action T3 guard", () => {
  test("requires a one-shot override before direct Claude spawn and retains the mark", async () => {
    const { openIndex } = await import("../index/schema.ts");
    const { openCatalogue } = await import("../catalogue/db-schema.ts");
    const { getRow } = await import("../catalogue/db-queries.ts");
    const { markT3Associated, setResumeId } = await import("../catalogue/db-mutations.ts");
    const { DEFAULT_LAUNCHERS } = await import("./launchers.ts");
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-resume-t3-"));
    const indexPath = join(directory, "index.db");
    const cataloguePath = join(directory, "catalogue.db");
    const now = "2026-08-22T00:00:00Z";
    const idx = openIndex(indexPath);
    const cat = openCatalogue(cataloguePath, { materialize: false });
    try {
      idx.query(
        `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
           fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
         VALUES ('t3', 'h', '/store/t3.jsonl', '/tmp', '/tmp', 'p', 't3', $now, $now, 1, 0, 0, 0, 't3')`,
      ).run({ $now: now });
      setResumeId(cat, "t3", "t3", now);
      expect(markT3Associated(cat, "t3", "t3", now)).toBe("changed");
      let spawns = 0;
      const bridge = {
        surfaces: [], surfaceToWorkspace: new Map(), workspaceIds: () => [], surfacesInWorkspace: () => [],
        surfaceInfo: () => null, locateSession: () => null, isOpen: () => false,
        primarySurface: () => null, activeWindowId: null, readable: true,
      } as unknown as Bridge;
      const action = createSidebarResumeAction({
        processAdapter: {
          async run(): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
            spawns += 1;
            return { ok: true, stdout: "OK workspace:95", stderr: "", timedOut: false };
          },
        },
        indexPath,
        cataloguePath,
        logger: logger([]),
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const refused = await action({ bridge, sessionId: "t3", cmuxBin: "cmux", launchers: DEFAULT_LAUNCHERS });
        expect(refused.status).toBe("ok");
        if (refused.status === "ok") expect(refused.result.status).toBe("t3-confirmation-required");
      }
      expect(spawns).toBe(0);

      const resumed = await action({
        bridge, sessionId: "t3", cmuxBin: "cmux", launchers: DEFAULT_LAUNCHERS, resumeT3Anyway: true,
      });
      expect(resumed.status).toBe("ok");
      if (resumed.status === "ok") expect(resumed.result.status).toBe("resumed");
      expect(spawns).toBe(1);
      expect(getRow(cat, "t3")?.t3Associated).toBeTrue();
    } finally {
      idx.close();
      cat.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("sidebar resume action completed reopen", () => {
  test("completed confirmation precedes T3 confirmation and clears only after approved spawn", async () => {
    const { openIndex } = await import("../index/schema.ts");
    const { openCatalogue } = await import("../catalogue/db-schema.ts");
    const { getRow } = await import("../catalogue/db-queries.ts");
    const { markT3Associated, setCompleted, setResumeId } = await import("../catalogue/db-mutations.ts");
    const { DEFAULT_LAUNCHERS } = await import("./launchers.ts");
    const directory = mkdtempSync(join(tmpdir(), "ccs-sidebar-resume-reopen-"));
    const indexPath = join(directory, "index.db");
    const cataloguePath = join(directory, "catalogue.db");
    const NOW = "2026-08-11T00:00:00Z";
    const idx = openIndex(indexPath);
    const cat = openCatalogue(cataloguePath);
    try {
      idx.query(
        `INSERT INTO sessions (session_id, host, path, cwd, project_root, project_name,
           fallback_label, first_ts, last_ts, msg_count, file_mtime, file_size, is_subagent, resume_id)
         VALUES ('done', 'h', '/store/done.jsonl', '/tmp', '/tmp', 'p', 'done', $now, $now, 1, 0, 0, 0, 'done')`,
      ).run({ $now: NOW });
      setResumeId(cat, "done", "done", NOW);
      setCompleted(cat, "done", true, NOW);
      markT3Associated(cat, "done", "done", NOW);

      const bridge = {
        surfaces: [],
        surfaceToWorkspace: new Map(),
        workspaceIds: () => [],
        surfacesInWorkspace: () => [],
        surfaceInfo: () => null,
        locateSession: () => null,
        isOpen: () => false,
        primarySurface: () => null,
        activeWindowId: null,
        readable: true,
      } as unknown as Bridge;
      const action = createSidebarResumeAction({
        processAdapter: {
          async run(): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
            return { ok: true, stdout: "OK workspace:94", stderr: "", timedOut: false };
          },
        },
        indexPath,
        cataloguePath,
        logger: logger([]),
      });

      const refused = await action({
        bridge,
        sessionId: "done",
        cmuxBin: "cmux",
        launchers: DEFAULT_LAUNCHERS,
      });
      expect(refused.status).toBe("ok");
      if (refused.status === "ok") expect(refused.result.status).toBe("completed");

      const needsT3Confirmation = await action({
        bridge,
        sessionId: "done",
        cmuxBin: "cmux",
        launchers: DEFAULT_LAUNCHERS,
        reopenCompleted: true,
      });
      expect(needsT3Confirmation.status).toBe("ok");
      if (needsT3Confirmation.status === "ok") {
        expect(needsT3Confirmation.result.status).toBe("t3-confirmation-required");
      }
      expect(getRow(cat, "done")?.completed).toBeTrue();

      const reopened = await action({
        bridge,
        sessionId: "done",
        cmuxBin: "cmux",
        launchers: DEFAULT_LAUNCHERS,
        reopenCompleted: true,
        resumeT3Anyway: true,
      });
      expect(reopened.status).toBe("ok");
      if (reopened.status === "ok") expect(reopened.result.status).toBe("resumed");
      expect(getRow(cat, "done")?.completed).toBeFalse();
      expect(getRow(cat, "done")?.t3Associated).toBeTrue();
    } finally {
      idx.close();
      cat.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
