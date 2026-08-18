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

describe("sidebar resume action completed reopen", () => {
  test("reopenCompleted clears Completed through the catalogue; without it the resume refuses", async () => {
    const { openIndex } = await import("../index/schema.ts");
    const { openCatalogue } = await import("../catalogue/db-schema.ts");
    const { getRow } = await import("../catalogue/db-queries.ts");
    const { setCompleted, setResumeId } = await import("../catalogue/db-mutations.ts");
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

      const reopened = await action({
        bridge,
        sessionId: "done",
        cmuxBin: "cmux",
        launchers: DEFAULT_LAUNCHERS,
        reopenCompleted: true,
      });
      expect(reopened.status).toBe("ok");
      if (reopened.status === "ok") expect(reopened.result.status).toBe("resumed");
      expect(getRow(cat, "done")?.completed).toBeFalse();
    } finally {
      idx.close();
      cat.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
