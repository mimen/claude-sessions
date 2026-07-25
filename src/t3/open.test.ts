import { expect, test } from "bun:test";
import type { SessionRow } from "../index/index.ts";
import { encodePath } from "../resume/locate.ts";
import {
  buildT3OpenArgv,
  openT3Session,
  resolveT3OpenCwd,
  type T3CwdResolverSeams,
  type T3Process,
} from "./open.ts";

const encoder = new TextEncoder();

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "session-id",
    host: "host",
    path: `/store/${encodePath("/recorded")}/session-id.jsonl`,
    cwd: "/recorded",
    projectRoot: "/recorded",
    projectName: "recorded",
    branch: null,
    version: null,
    firstTs: null,
    lastTs: null,
    msgCount: 1,
    fileSize: 1,
    title: "A root session",
    titleSource: "fallback",
    isSubagent: false,
    parentSessionId: null,
    resumeId: "8e3ca950-5a7b-4ff7-8eaa-a951a44f8282",
    costUSD: 0,
    tokInput: 0,
    tokOutput: 0,
    tokCacheRead: 0,
    tokCacheWrite: 0,
    costByModel: {},
    models: [],
    lastModel: "",
    userTurns: 1,
    tickIntervalSec: 0,
    ...overrides,
  };
}

function process(stdout: string, stderr: string, exitCode: Promise<number>, onKill: () => void = () => {}): T3Process {
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

function resolver(overrides: Partial<T3CwdResolverSeams> = {}): T3CwdResolverSeams {
  return {
    realpath: (path) => path,
    ...overrides,
  };
}

test("buildT3OpenArgv uses the exact argv contract and no shell string", () => {
  expect(
    buildT3OpenArgv({ resumeId: "resume-uuid", cwd: "/absolute cwd" }, "/custom/t3"),
  ).toEqual(["/custom/t3", "session", "open", "--resume-id", "resume-uuid", "--cwd", "/absolute cwd", "--json"]);
});

test("openT3Session captures argv and distinguishes an existing T3 thread", async () => {
  let argv: readonly string[] = [];
  const result = await openT3Session(
    { resumeId: "resume-uuid", cwd: "/absolute" },
    {
      binary: "t3-test",
      spawn: (args) => {
        argv = args;
        return process(
          JSON.stringify({ ok: true, value: { threadId: "thread-1", projectId: "project-1", created: false } }),
          "",
          Promise.resolve(0),
        );
      },
    },
  );

  expect(argv).toEqual(["t3-test", "session", "open", "--resume-id", "resume-uuid", "--cwd", "/absolute", "--json"]);
  expect(result).toEqual({ kind: "opened", threadId: "thread-1", projectId: "project-1", created: false });
});

test("openT3Session maps typed result errors before nonzero exits", async () => {
  const result = await openT3Session(
    { resumeId: "resume-uuid", cwd: "/absolute" },
    {
      spawn: () =>
        process(
          JSON.stringify({ ok: false, error: { code: "source_not_found", message: "No Claude session found" } }),
          "diagnostic on stderr",
          Promise.resolve(1),
        ),
    },
  );

  expect(result).toEqual({
    kind: "failure",
    reason: "result-failure",
    resultCode: "source_not_found",
    message: "No Claude session found",
    stderr: "diagnostic on stderr",
  });
});

test("openT3Session classifies malformed output, a nonzero exit, missing executable, and timeout", async () => {
  const malformed = await openT3Session(
    { resumeId: "resume-uuid", cwd: "/absolute" },
    { spawn: () => process("not json", "", Promise.resolve(0)) },
  );
  expect(malformed.kind === "failure" && malformed.reason).toBe("malformed-output");

  const nonzero = await openT3Session(
    { resumeId: "resume-uuid", cwd: "/absolute" },
    { spawn: () => process("not json", "fatal diagnostic", Promise.resolve(2)) },
  );
  expect(nonzero).toMatchObject({ kind: "failure", reason: "nonzero", exitCode: 2, stderr: "fatal diagnostic" });

  const missing = await openT3Session(
    { resumeId: "resume-uuid", cwd: "/absolute" },
    {
      spawn: () => {
        const error = Object.assign(new Error("spawn t3 ENOENT"), { code: "ENOENT" });
        throw error;
      },
    },
  );
  expect(missing.kind === "failure" && missing.reason).toBe("missing-executable");

  let killed = false;
  const neverExits = new Promise<number>(() => {});
  const timeout = await openT3Session(
    { resumeId: "resume-uuid", cwd: "/absolute" },
    { timeoutMs: 1, spawn: () => process("", "", neverExits, () => { killed = true; }) },
  );
  expect(killed).toBe(true);
  expect(timeout.kind === "failure" && timeout.reason).toBe("timeout");
});

test("resolveT3OpenCwd accepts only a recorded cwd verified against its storage folder", () => {
  const recorded = resolveT3OpenCwd(row(), resolver());
  expect(recorded).toEqual({ ok: true, cwd: "/recorded" });

  const canonical = resolveT3OpenCwd(
    row({ cwd: "/recorded-link" }),
    resolver({ realpath: () => "/recorded" }),
  );
  expect(canonical).toEqual({ ok: true, cwd: "/recorded" });

  const missing = resolveT3OpenCwd(row({ cwd: null }), resolver());
  expect(missing).toEqual({ ok: false, reason: "session has no recorded absolute cwd" });
});
