import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { getRow } from "../catalogue/db-queries.ts";
import { err, ok, type Result } from "../result.ts";
import type { CloseSessionWorkspaceOutcome } from "./close-current.ts";
import {
  explicitCurrentSessionId,
  explicitSessionId,
  finishCurrentCommand,
  finishSession,
  finishSessionCommand,
  type FinishCommandDependencies,
  type FinishCurrentDependencies,
  type FinishSessionDependencies,
} from "./finish-current.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SURFACE_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const WORKSPACE_ID = "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC";

function closeOutcome(
  sessionId: string,
  mutate: boolean,
): CloseSessionWorkspaceOutcome {
  const identity = { sessionId, surfaceId: SURFACE_ID, workspaceId: WORKSPACE_ID };
  return mutate
    ? { status: "closed", identity }
    : { status: "authorized", dryRun: true, identity };
}

interface CommandState {
  readonly sessionDeps: FinishSessionDependencies;
  readonly commandDeps: FinishCommandDependencies;
  readonly currentDeps: FinishCurrentDependencies;
  readonly order: string[];
  readonly stdout: string[];
  readonly stderr: string[];
}

function commandState(options: {
  readonly catalogueResult?: Result<void>;
  readonly lifecycleResult?: Result<void>;
  readonly launchResult?: Result<{ readonly logPath: string }>;
  readonly closeResult?: CloseSessionWorkspaceOutcome;
  readonly sessionId?: string;
} = {}): CommandState {
  const order: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sessionDeps: FinishSessionDependencies = {
    recordLifecycle(sessionId, lifecycle): Result<void> {
      order.push(`lifecycle:${lifecycle}:${sessionId}`);
      return options.lifecycleResult ?? ok(undefined);
    },
    launchEnrichment(sessionId): Result<{ readonly logPath: string }> {
      order.push(`launch:${sessionId}`);
      return options.launchResult ?? ok({ logPath: `/runtime/enrich/${sessionId}.log` });
    },
    async closeSessionWorkspace(sessionId, mutate): Promise<CloseSessionWorkspaceOutcome> {
      order.push(`close:${sessionId}:${mutate ? "do" : "dry"}`);
      return options.closeResult ?? closeOutcome(sessionId, mutate);
    },
  };
  const commandDeps: FinishCommandDependencies = {
    ...sessionDeps,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return {
    sessionDeps,
    commandDeps,
    currentDeps: {
      ...commandDeps,
      environment: { CLAUDE_CODE_SESSION_ID: options.sessionId ?? SESSION_ID },
    },
    order,
    stdout,
    stderr,
  };
}

describe("finishSession", () => {
  test("dry run performs only the explicit-session close preflight", async () => {
    const state = commandState();

    const outcome = await finishSession(SESSION_ID, "complete", false, state.sessionDeps);

    expect(outcome).toEqual({
      status: "close-result",
      sessionId: SESSION_ID,
      lifecycle: "complete",
      lifecycleRecorded: false,
      enrichmentWarning: null,
      close: closeOutcome(SESSION_ID, false),
    });
    expect(state.order).toEqual([`close:${SESSION_ID}:dry`]);
  });

  test("--do preserves exact ensure, lifecycle, launch, close ordering", async () => {
    const state = commandState();

    const outcome = await finishSession(SESSION_ID, "complete", true, state.sessionDeps);

    expect(outcome.status).toBe("close-result");
    expect(state.order).toEqual([
      `lifecycle:complete:${SESSION_ID}`,
      `launch:${SESSION_ID}`,
      `close:${SESSION_ID}:do`,
    ]);
  });

  test("lifecycle failure does not enqueue enrichment or close", async () => {
    const state = commandState({ lifecycleResult: err(new Error("write failed")) });

    const outcome = await finishSession(SESSION_ID, "complete", true, state.sessionDeps);

    expect(outcome.status).toBe("lifecycle-failed");
    expect(state.order).toEqual([
      `lifecycle:complete:${SESSION_ID}`,
    ]);
  });

  test("immediate enrichment launch failure records a warning and continues closing", async () => {
    const state = commandState({ launchResult: err(new Error("spawn failed")) });

    const outcome = await finishSession(SESSION_ID, "save", true, state.sessionDeps);

    expect(state.order.at(-1)).toBe(`close:${SESSION_ID}:do`);
    expect(outcome.status).toBe("close-result");
    if (outcome.status === "close-result") {
      expect(outcome.enrichmentWarning).toContain("spawn failed");
      expect(outcome.enrichmentWarning).toContain("ccs enrich --sweep can retry");
    }
  });

  test("invalid explicit session UUID refuses before any mutation", async () => {
    const state = commandState();

    const outcome = await finishSession("not-a-uuid", "complete", true, state.sessionDeps);

    expect(outcome.status).toBe("invalid-session");
    expect(state.order).toEqual([]);
  });
});

describe("finishCurrentCommand", () => {
  test("resolves the current UUID then delegates to the general form", async () => {
    const state = commandState({ sessionId: OTHER_SESSION_ID });

    expect(await finishCurrentCommand(["save", "--do"], state.currentDeps)).toBe(0);
    expect(state.order).toEqual([
      `lifecycle:save:${OTHER_SESSION_ID}`,
      `launch:${OTHER_SESSION_ID}`,
      `close:${OTHER_SESSION_ID}:do`,
    ]);
    expect(state.order.join("\n")).not.toContain(".");
  });

  test("renders enrichment warnings and still closes", async () => {
    const state = commandState({ launchResult: err(new Error("spawn failed")) });

    expect(await finishCurrentCommand(["save", "--do"], state.currentDeps)).toBe(0);
    expect(state.order.at(-1)).toBe(`close:${SESSION_ID}:do`);
    expect(state.stderr.join("\n")).toContain("warning: spawn failed");
    expect(state.stderr.join("\n")).toContain("ccs enrich --sweep can retry");
  });

  test("propagates structured close refusal and failure return codes", async () => {
    const refused = commandState({
      closeResult: { status: "refused", phase: "revalidation", reason: "surface-not-live" },
    });
    expect(await finishCurrentCommand(["complete", "--do"], refused.currentDeps)).toBe(2);
    expect(JSON.parse(refused.stderr.at(-1) ?? "{}")).toMatchObject({
      status: "refused",
      phase: "revalidation",
      reason: "surface-not-live",
    });

    const failed = commandState({
      closeResult: {
        status: "close-failed",
        identity: { sessionId: SESSION_ID, surfaceId: SURFACE_ID, workspaceId: WORKSPACE_ID },
      },
    });
    expect(await finishCurrentCommand(["complete", "--do"], failed.currentDeps)).toBe(1);
    expect(JSON.parse(failed.stderr.at(-1) ?? "{}")).toMatchObject({
      status: "close-failed",
      workspaceId: WORKSPACE_ID,
    });
  });

  test("invalid current session UUID refuses before any mutation", async () => {
    const state = commandState({ sessionId: "not-a-uuid" });

    expect(await finishCurrentCommand(["complete", "--do"], state.currentDeps)).toBe(2);
    expect(state.order).toEqual([]);
    expect(state.stderr.join("\n")).toContain("CLAUDE_CODE_SESSION_ID is not a UUID");
  });

  test("production path refuses a session the catalogue does not know", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-finish-current-"));
    const prior = {
      CCS_ROOT: process.env.CCS_ROOT,
      CCS_BIN: process.env.CCS_BIN,
      CMUX_BIN: process.env.CMUX_BIN,
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.CCS_ROOT = root;
      process.env.CCS_BIN = "/usr/bin/true";
      process.env.CMUX_BIN = "/usr/bin/false";
      process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID;

      // `ccs mark` refuses an id it has no row for, so that a typo cannot conjure a phantom
      // session. Finishing an unknown session now fails with that refusal instead of creating
      // the bare row itself, and nothing downstream runs.
      expect(await finishCurrentCommand(["complete", "--do"])).toBe(1);

      const catalogue = openCatalogue(join(root, "cache", "catalogue.db"));
      try {
        expect(getRow(catalogue, SESSION_ID)).toBeNull();
      } finally {
        catalogue.close();
      }
      expect(existsSync(join(root, "enrich", `${SESSION_ID}.log`))).toBe(false);
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

describe("finishSessionCommand", () => {
  test("exposes the explicit-session CLI shape", async () => {
    const state = commandState({ sessionId: OTHER_SESSION_ID });

    expect(await finishSessionCommand(
      [SESSION_ID, "complete", "--do"],
      state.commandDeps,
    )).toBe(0);
    expect(state.order[0]).toBe(`lifecycle:complete:${SESSION_ID}`);
    expect(state.order.at(-1)).toBe(`close:${SESSION_ID}:do`);
  });

  test("rejects malformed arguments", async () => {
    const state = commandState();
    expect(await finishSessionCommand([SESSION_ID, "uncomplete"], state.commandDeps)).toBe(2);
    expect(state.order).toEqual([]);
    expect(state.stderr.join("\n")).toContain(
      "usage: ccs finish <sessionId> <complete|save> [--do]",
    );
  });
});

describe("explicit session ids", () => {
  test("accepts only explicit UUIDs", () => {
    expect(explicitSessionId(SESSION_ID)).toEqual(ok(SESSION_ID));
    expect(explicitSessionId(".").ok).toBeFalse();
    expect(explicitCurrentSessionId({ CLAUDE_CODE_SESSION_ID: SESSION_ID })).toEqual(ok(SESSION_ID));
    expect(explicitCurrentSessionId({}).ok).toBeFalse();
  });
});
