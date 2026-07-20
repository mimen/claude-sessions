import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCrashReporter, summarizeArgv } from "./crashlog.ts";

interface MemoryFileSystem {
  files: Map<string, string>;
  fail: boolean;
  mkdir(path: string): void;
  append(path: string, content: string): void;
  size(path: string): number | null;
  rename(from: string, to: string): void;
}

function memoryFileSystem(): MemoryFileSystem {
  return {
    files: new Map(), fail: false,
    mkdir(): void {},
    append(path, content): void {
      if (this.fail) throw new Error("disk unavailable");
      this.files.set(path, (this.files.get(path) ?? "") + content);
    },
    size(path): number | null { return this.files.get(path)?.length ?? null; },
    rename(from, to): void {
      if (this.fail) throw new Error("disk unavailable");
      const value = this.files.get(from);
      if (value === undefined) throw new Error("missing");
      this.files.set(to, value);
      this.files.delete(from);
    },
  };
}

describe("summarizeArgv", () => {
  test("never includes positional or flag values", () => {
    const summary = summarizeArgv(["session", "set", "super-secret", "--prompt", "private words", "--json={\"token\":\"hidden\"}"]);
    expect(summary).toEqual({ command: "session", subcommand: "set", flags: "--prompt,--json", argumentCount: 6 });
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("private");
    expect(JSON.stringify(summary)).not.toContain("hidden");
  });

  test("redacts compact and equals-form short-option values", () => {
    const summary = summarizeArgv(["session", "new", "-p=private-prompt", "-n5", "-tsecret-title"]);
    expect(summary).toEqual({ command: "session", subcommand: "new", flags: "-p,-n,-t", argumentCount: 5 });
    expect(JSON.stringify(summary)).not.toContain("private-prompt");
    expect(JSON.stringify(summary)).not.toContain("-n5");
    expect(JSON.stringify(summary)).not.toContain("secret-title");
  });

  test("does not mistake arbitrary positional values for structural subcommands", () => {
    expect(summarizeArgv(["rename", "top-secret-title"])).toMatchObject({ command: "rename", subcommand: null });
    expect(summarizeArgv(["status", "private status"])).toMatchObject({ command: "status", subcommand: null });
    expect(summarizeArgv(["custom-secret-command", "also-secret"])).toMatchObject({ command: null, subcommand: null });
  });
});

test("installed fatal handlers restore the terminal and write a redacted correlated crash record", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-crash-handler-"));
  const script = `import { installCrashLog } from "${join(import.meta.dir, "crashlog.ts")}"; installCrashLog(); throw new Error("Authorization: Bearer child-secret");`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, CCS_ROOT: root }, stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(1);
  expect(stdout).toContain("\x1b[?1049l");
  expect(stderr).toContain("ccs crashed");
  const record = JSON.parse(readFileSync(join(root, "crash.log"), "utf8")) as { runId: string; invocation: object | null; error: { stack: string } };
  expect(record.runId).toBeTruthy();
  expect(record.invocation).not.toBeNull();
  expect(record.error.stack).not.toContain("child-secret");
});

describe("createCrashReporter", () => {
  test("keeps a correlated in-memory breadcrumb when debug is disabled", () => {
    const fs = memoryFileSystem();
    const reporter = createCrashReporter({ root: "/logs", runId: () => "run-1", debugEnabled: false, fileSystem: fs });
    reporter.invocation(summarizeArgv(["session", "set", "private-value"]));
    reporter.breadcrumb("tui.cmux.titles.success", { count: 2 });
    reporter.crash("unhandledRejection", new Error("bounded failure"));
    expect(fs.files.has("/logs/ccs-debug.log")).toBe(false);
    const line = fs.files.get("/logs/crash.log")!;
    const record = JSON.parse(line) as { runId: string; invocation: { command: string; subcommand: string; argumentCount: number }; lastBreadcrumb: { kind: string; at: string; runId: string; event: string; facts: { count: number } } };
    expect(record.runId).toBe("run-1");
    expect(record.invocation).toMatchObject({ command: "session", subcommand: "set", argumentCount: 3 });
    expect(record.lastBreadcrumb).toEqual({ kind: "breadcrumb", at: expect.any(String), runId: "run-1", event: "tui.cmux.titles.success", facts: { count: 2 } });
  });

  test("writes valid JSONL, bounds stack records, and rotates one generation", () => {
    const fs = memoryFileSystem();
    const reporter = createCrashReporter({ root: "/logs", runId: () => "run-2", debugEnabled: true, maxFileBytes: 300, maxRecordBytes: 512, fileSystem: fs });
    reporter.breadcrumb("cli.start", { argumentCount: 2 });
    reporter.crash("uncaughtException", new Error("x".repeat(1_000)));
    reporter.crash("uncaughtException", new Error("y".repeat(1_000)));
    const current = fs.files.get("/logs/crash.log")!;
    for (const line of current.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    expect(current.length).toBeLessThanOrEqual(513);
    expect(fs.files.has("/logs/crash.log.1")).toBe(true);
    const debug = fs.files.get("/logs/ccs-debug.log")!;
    expect(JSON.parse(debug).runId).toBe("run-2");
  });

  test("redacts credentials from persisted errors and nested breadcrumb facts", () => {
    const fs = memoryFileSystem();
    const reporter = createCrashReporter({ root: "/logs", debugEnabled: true, fileSystem: fs });
    reporter.breadcrumb("request", {
      auth: "Authorization: Bearer bearer-secret",
      nested: { password: "password=hunter2", url: "https://example.test/?token=query-secret&api_key=key-secret" },
      cookies: ["Cookie: session=cookie-secret"],
    });
    reporter.crash("uncaughtException", new Error("api_key=error-key Authorization: Bearer error-bearer Cookie: sid=error-cookie"));
    const persisted = [...fs.files.values()].join("\n");
    for (const secret of ["bearer-secret", "hunter2", "query-secret", "key-secret", "cookie-secret", "error-key", "error-bearer", "error-cookie"]) {
      expect(persisted).not.toContain(secret);
    }
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).toContain("https://example.test/?token=[REDACTED]&api_key=[REDACTED]");
  });

  test("swallows filesystem failures", () => {
    const fs = memoryFileSystem();
    fs.fail = true;
    const reporter = createCrashReporter({ root: "/logs", fileSystem: fs });
    expect(() => reporter.breadcrumb("cli.start")).not.toThrow();
    expect(() => reporter.crash("uncaughtException", new Error("boom"))).not.toThrow();
  });
});
