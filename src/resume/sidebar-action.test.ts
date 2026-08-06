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
