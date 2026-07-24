import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import {
  buildT3AttachmentStatusArgv,
  joinT3AttachmentsToRootSessions,
  readT3AttachmentStatusSnapshot,
  t3AttachmentIndicator,
  type T3AttachmentStatus,
  type T3StatusProcess,
} from "./status.ts";

const encoder = new TextEncoder();

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "local-row",
    host: "test-host",
    path: "/store/local-row.jsonl",
    cwd: "/workspace/project",
    projectRoot: "/workspace/project",
    projectName: "project",
    branch: null,
    version: null,
    firstTs: null,
    lastTs: null,
    msgCount: 1,
    fileSize: 1,
    title: "Root session",
    titleSource: "fallback",
    isSubagent: false,
    parentSessionId: null,
    resumeId: "native-resume-id",
    costUSD: 0,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: {},
    models: [],
    userTurns: 1,
    tickIntervalSec: 0,
    ...overrides,
  };
}

function attachment(overrides: Partial<T3AttachmentStatus> = {}): T3AttachmentStatus {
  return {
    providerInstanceId: "claudeAgent",
    localSourceHost: "test-host",
    nativeSessionId: "native-resume-id",
    sourceCwd: "/workspace/project",
    sourceId: "source-1",
    threadId: "thread-1",
    projectId: "project-1",
    state: "synced",
    lastSyncedAt: "2026-07-22T12:00:00.000Z",
    diagnostic: null,
    runtimeStatus: "running",
    runtimeLastSeenAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function process(
  stdout: string,
  stderr: string,
  exitCode: Promise<number>,
  onKill: () => void = () => {},
): T3StatusProcess {
  return {
    stdout: textStream(stdout),
    stderr: textStream(stderr),
    exited: exitCode,
    kill: onKill,
  };
}

function textStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function successEnvelope(attachments: readonly T3AttachmentStatus[]): string {
  return JSON.stringify({
    ok: true,
    value: {
      protocolVersion: 1,
      generatedAt: "2026-07-22T12:00:00.000Z",
      attachments,
    },
  });
}

test("attachment-status client invokes one read-only snapshot command", async () => {
  expect(buildT3AttachmentStatusArgv("/custom/t3")).toEqual([
    "/custom/t3",
    "session",
    "status",
    "--json",
  ]);

  let calls = 0;
  let argv: readonly string[] = [];
  const result = await readT3AttachmentStatusSnapshot({
    binary: "t3-test",
    spawn: (args) => {
      calls++;
      argv = args;
      return process(successEnvelope([attachment()]), "", Promise.resolve(0));
    },
  });

  expect(calls).toBe(1);
  expect(argv).toEqual(["t3-test", "session", "status", "--json"]);
  expect(result).toEqual({
    kind: "snapshot",
    snapshot: {
      protocolVersion: 1,
      generatedAt: "2026-07-22T12:00:00.000Z",
      attachments: [attachment()],
    },
  });
});

test("attachment-status client validates failures and enforces its deadline", async () => {
  const resultFailure = await readT3AttachmentStatusSnapshot({
    spawn: () =>
      process(
        JSON.stringify({ ok: false, error: { code: "t3_unavailable", message: "No running T3 server" } }),
        "",
        Promise.resolve(0),
      ),
  });
  expect(resultFailure).toMatchObject({
    kind: "failure",
    reason: "result-failure",
    resultCode: "t3_unavailable",
  });

  const malformedEnvelope = JSON.stringify({
    ok: true,
    value: {
      protocolVersion: 1,
      generatedAt: "2026-07-22T12:00:00.000Z",
      attachments: [{ ...attachment(), runtimeStatus: "paused" }],
    },
  });
  const malformed = await readT3AttachmentStatusSnapshot({
    spawn: () => process(malformedEnvelope, "", Promise.resolve(0)),
  });
  expect(malformed).toMatchObject({ kind: "failure", reason: "malformed-output" });

  let killed = false;
  const neverExits = new Promise<number>(() => {});
  const timeout = await readT3AttachmentStatusSnapshot({
    timeoutMs: 1,
    spawn: () => process("", "", neverExits, () => { killed = true; }),
  });
  expect(killed).toBe(true);
  expect(timeout).toMatchObject({ kind: "failure", reason: "timeout" });
});

test("attachment snapshot joins only local root rows with the same source identity", () => {
  const matching = attachment();
  const joined = joinT3AttachmentsToRootSessions(
    [
      row(),
      row({ sessionId: "wrong-host", host: "other-host" }),
      row({ sessionId: "wrong-resume", resumeId: "other-native-id" }),
      row({ sessionId: "wrong-cwd", cwd: "/workspace/other" }),
      row({ sessionId: "subagent", isSubagent: true }),
      row({ sessionId: "not-resumable", resumeId: "" }),
    ],
    [
      matching,
      attachment({ sourceId: "wrong-provider", providerInstanceId: "other-provider" }),
    ],
    (cwd) => cwd,
  );

  expect([...joined.keys()]).toEqual(["local-row"]);
  expect(joined.get("local-row")).toBe(matching);
});

test("attachment join skips canonicalization when no snapshot can match", () => {
  let resolutions = 0;
  expect(
    joinT3AttachmentsToRootSessions([row()], [], (cwd) => {
      resolutions++;
      return cwd;
    }),
  ).toEqual(new Map());
  expect(resolutions).toBe(0);

  expect(
    joinT3AttachmentsToRootSessions([row()], [attachment()], () => {
      throw new Error("working directory vanished");
    }),
  ).toEqual(new Map());
});

test("attachment indicator reserves cobalt for a healthy running provider", () => {
  expect(t3AttachmentIndicator(attachment())).toEqual({
    kind: "running",
    label: "T3 attachment running; sync synced; provider running",
  });
  expect(t3AttachmentIndicator(attachment({ state: "failed" }))).toEqual({
    kind: "unhealthy",
    label: "T3 attachment unhealthy; sync failed; provider running",
  });
  expect(t3AttachmentIndicator(attachment({ runtimeStatus: "stopped" }))).toEqual({
    kind: "unhealthy",
    label: "T3 attachment unhealthy; sync synced; provider stopped",
  });
  expect(t3AttachmentIndicator(attachment({ diagnostic: "sync needs repair" }))).toEqual({
    kind: "unhealthy",
    label: "T3 attachment unhealthy; sync synced; provider running; diagnostic present",
  });
});
