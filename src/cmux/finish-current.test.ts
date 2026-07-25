import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRow, openCatalogue } from "../catalogue/db.ts";
import { err, ok, type Result } from "../result.ts";
import {
  explicitCurrentSessionId,
  finishCurrentCommand,
  type FinishCurrentDependencies,
} from "./finish-current.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

interface CommandState {
  readonly deps: FinishCurrentDependencies;
  readonly order: string[];
  readonly stderr: string[];
  readonly closeArgs: string[][];
}

function commandState(options: {
  readonly lifecycleResult?: Result<void>;
  readonly launchResult?: Result<{ readonly logPath: string }>;
  readonly closeResult?: number;
  readonly sessionId?: string;
} = {}): CommandState {
  const order: string[] = [];
  const stderr: string[] = [];
  const closeArgs: string[][] = [];
  return {
    deps: {
      environment: { CLAUDE_CODE_SESSION_ID: options.sessionId ?? SESSION_ID },
      ensureCatalogueRow(sessionId): Result<void> {
        order.push(`ensure:${sessionId}`);
        return ok(undefined);
      },
      recordLifecycle(sessionId, lifecycle): Result<void> {
        order.push(`lifecycle:${lifecycle}:${sessionId}`);
        return options.lifecycleResult ?? ok(undefined);
      },
      launchEnrichment(sessionId): Result<{ readonly logPath: string }> {
        order.push(`launch:${sessionId}`);
        return options.launchResult ?? ok({ logPath: `/runtime/enrich/${sessionId}.log` });
      },
      closeCurrentWorkspace(args): number {
        order.push(`close:${args.join(",")}`);
        closeArgs.push([...args]);
        return options.closeResult ?? 0;
      },
      stderr: (line) => stderr.push(line),
    },
    order,
    stderr,
    closeArgs,
  };
}

describe("finishCurrentCommand", () => {
  test("dry run performs only the existing close-current-workspace preflight", () => {
    const state = commandState();

    expect(finishCurrentCommand(["complete"], state.deps)).toBe(0);
    expect(state.order).toEqual(["close:"]);
    expect(state.closeArgs).toEqual([[]]);
  });

  test("--do preserves exact ensure, lifecycle, launch, close ordering", () => {
    const state = commandState();

    expect(finishCurrentCommand(["complete", "--do"], state.deps)).toBe(0);
    expect(state.order).toEqual([
      `ensure:${SESSION_ID}`,
      `lifecycle:complete:${SESSION_ID}`,
      `launch:${SESSION_ID}`,
      "close:--do",
    ]);
  });

  test("uses the explicit current UUID for archive lifecycle and enrichment", () => {
    const explicit = "22222222-2222-4222-8222-222222222222";
    const state = commandState({ sessionId: explicit });

    expect(finishCurrentCommand(["archive", "--do"], state.deps)).toBe(0);
    expect(state.order).toEqual([
      `ensure:${explicit}`,
      `lifecycle:archive:${explicit}`,
      `launch:${explicit}`,
      "close:--do",
    ]);
    expect(state.order.join("\n")).not.toContain(".");
  });

  test("lifecycle failure does not enqueue enrichment or close", () => {
    const state = commandState({ lifecycleResult: err(new Error("write failed")) });

    expect(finishCurrentCommand(["complete", "--do"], state.deps)).toBe(1);
    expect(state.order).toEqual([
      `ensure:${SESSION_ID}`,
      `lifecycle:complete:${SESSION_ID}`,
    ]);
    expect(state.stderr.join("\n")).toContain("lifecycle failed: write failed");
  });

  test("immediate enrichment launch failure warns and continues closing", () => {
    const state = commandState({
      launchResult: err(new Error("spawn failed")),
      closeResult: 0,
    });

    expect(finishCurrentCommand(["archive", "--do"], state.deps)).toBe(0);
    expect(state.order.at(-1)).toBe("close:--do");
    expect(state.stderr.join("\n")).toContain("warning: spawn failed");
    expect(state.stderr.join("\n")).toContain("ccs enrich --sweep can retry");
  });

  test("propagates close refusal and failure return codes unchanged", () => {
    for (const closeResult of [2, 1]) {
      const state = commandState({ closeResult });
      expect(finishCurrentCommand(["complete", "--do"], state.deps)).toBe(closeResult);
      expect(state.order.at(-1)).toBe("close:--do");
    }
  });

  test("invalid explicit session UUID refuses before any mutation", () => {
    const state = commandState({ sessionId: "not-a-uuid" });

    expect(finishCurrentCommand(["complete", "--do"], state.deps)).toBe(2);
    expect(state.order).toEqual([]);
    expect(state.stderr.join("\n")).toContain("CLAUDE_CODE_SESSION_ID is not a UUID");
  });

  test("production path creates an uncatalogued row and records lifecycle before close refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-finish-current-"));
    const prior = {
      CCS_ROOT: process.env.CCS_ROOT,
      CCS_BIN: process.env.CCS_BIN,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      CMUX_SURFACE_ID: process.env.CMUX_SURFACE_ID,
      CMUX_WORKSPACE_ID: process.env.CMUX_WORKSPACE_ID,
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.CCS_ROOT = root;
      process.env.CCS_BIN = "/usr/bin/true";
      process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID;
      delete process.env.CMUX_SURFACE_ID;
      delete process.env.CMUX_WORKSPACE_ID;

      expect(finishCurrentCommand(["complete", "--do"])).toBe(2);

      const catalogue = openCatalogue(join(root, "cache", "catalogue.db"));
      try {
        const row = getRow(catalogue, SESSION_ID);
        expect(row?.completed).toBe(true);
        expect(row?.archived).toBe(false);
      } finally {
        catalogue.close();
      }
      expect(existsSync(join(root, "enrich", `${SESSION_ID}.log`))).toBe(true);
    } finally {
      log.mockRestore();
      error.mockRestore();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("explicitCurrentSessionId", () => {
  test("accepts only the environment UUID", () => {
    expect(explicitCurrentSessionId({ CLAUDE_CODE_SESSION_ID: SESSION_ID })).toEqual(ok(SESSION_ID));
    expect(explicitCurrentSessionId({}).ok).toBe(false);
  });
});
