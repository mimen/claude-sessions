import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { runtimeRoot } from "./paths.ts";

export const CRASH_LOG = (): string => join(runtimeRoot(), "crash.log");
export const DEBUG_LOG = (): string => join(runtimeRoot(), "ccs-debug.log");

export interface SafeFacts {
  readonly [key: string]: SafeValue;
}
export type SafeValue = string | number | boolean | null | readonly SafeValue[] | SafeFacts;
export interface CrashFacts extends SafeFacts {}

export interface ReporterFileSystem {
  mkdir(path: string): void;
  append(path: string, content: string): void;
  size(path: string): number | null;
  rename(from: string, to: string): void;
}

export interface CrashReporterOptions {
  root?: string;
  now?: () => Date;
  runId?: () => string;
  debugEnabled?: boolean;
  maxFileBytes?: number;
  maxRecordBytes?: number;
  fileSystem?: ReporterFileSystem;
}

export interface CrashReporter {
  readonly runId: string;
  invocation(summary: CrashFacts): void;
  breadcrumb(event: string, facts?: CrashFacts): void;
  crash(kind: "uncaughtException" | "unhandledRejection", error: Error | string): void;
}

interface BreadcrumbRecord {
  kind: "breadcrumb";
  at: string;
  runId: string;
  event: string;
  facts: CrashFacts;
}

interface CrashRecord {
  kind: "crash";
  at: string;
  runId: string;
  errorKind: "uncaughtException" | "unhandledRejection";
  error: { name: string; message: string; stack: string };
  runtime: CrashFacts;
  invocation: CrashFacts | null;
  lastBreadcrumb: BreadcrumbRecord | null;
}

const DEFAULT_FILE_LIMIT = 512 * 1024;
const DEFAULT_RECORD_LIMIT = 8 * 1024;

const productionFileSystem: ReporterFileSystem = {
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  append: (path, content) => appendFileSync(path, content),
  size: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  rename: (from, to) => renameSync(from, to),
};

function defaultRunId(): string {
  return randomUUID();
}

function bounded(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

/** Replace common credential-bearing text while retaining the surrounding diagnostic structure. */
export function redactDiagnosticText(text: string): string {
  return text
    .replace(/\b(authorization\s*:\s*bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password)\s*[=:]\s*["']?)[^\s,"'&}]+/gi, "$1[REDACTED]")
    .replace(/\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, "$1[REDACTED]");
}

function redactSafeValue(value: SafeValue): SafeValue {
  if (typeof value === "string") return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactSafeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSafeValue(nested)]));
  }
  return value;
}

function redactFacts(facts: CrashFacts): CrashFacts {
  return redactSafeValue(facts) as CrashFacts;
}

function safeError(error: Error | string, maximum: number): { name: string; message: string; stack: string } {
  if (typeof error === "string") {
    return { name: "Error", message: bounded(redactDiagnosticText(error), maximum), stack: "" };
  }
  return {
    name: bounded(redactDiagnosticText(error.name || "Error"), 120),
    message: bounded(redactDiagnosticText(error.message), maximum),
    stack: bounded(redactDiagnosticText(error.stack ?? error.message), maximum),
  };
}

function serializeBounded(record: BreadcrumbRecord | CrashRecord, maximum: number): string {
  const encode = (value: BreadcrumbRecord | CrashRecord): string => JSON.stringify(value);
  let candidate: BreadcrumbRecord | CrashRecord = record;
  if (Buffer.byteLength(encode(candidate)) > maximum && record.kind === "crash") {
    candidate = {
      ...record,
      error: { ...record.error, message: bounded(record.error.message, 256), stack: bounded(record.error.stack, Math.max(0, Math.floor(maximum / 4))) },
      lastBreadcrumb: null,
    };
  }
  if (Buffer.byteLength(encode(candidate)) > maximum) {
    candidate = record.kind === "crash"
      ? { ...record, error: { name: "Error", message: "truncated", stack: "" }, runtime: {}, invocation: null, lastBreadcrumb: null }
      : { ...record, event: "truncated", facts: {} };
  }
  return `${encode(candidate)}\n`;
}

function appendRotating(fs: ReporterFileSystem, root: string, file: string, content: string, maximum: number): void {
  try {
    fs.mkdir(root);
    const current = fs.size(file) ?? 0;
    if (current + Buffer.byteLength(content) > maximum) {
      try { fs.rename(file, `${file}.1`); } catch { /* no previous generation is fine */ }
    }
    fs.append(file, content);
  } catch {
    // Diagnostics must not become a second failure.
  }
}

/** A pure argv shape: command/subcommand, option names, and total argument count only. */
export function summarizeArgv(argv: readonly string[]): CrashFacts {
  const flags: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      flags.push(arg.split("=", 1)[0]!);
    } else if (arg.startsWith("-") && arg.length > 1) {
      // `-p=secret`, `-n5`, and `-psecret` are all value-bearing forms. Retaining the raw
      // token would leak the value, so report only the initial short-option name.
      flags.push(arg.slice(0, 2));
    }
  }
  const structuralCommands = new Set(["reindex", "ls", "tree", "whoami", "meta", "rename", "mark", "tag", "key", "parent", "project", "set-cluster", "role", "gus-work", "epic", "status", "name", "stage", "new-session", "delegate", "sync-tabs", "hook", "hooks", "catch-up", "context-check", "decide", "bump-session", "reap-duplicates", "statusline", "inbox", "state", "grouping", "roles", "sync-roles", "cluster", "catalogue", "identity", "session-fields", "session", "board", "resume-session", "resume-cluster", "resume", "self-check", "skills"]);
  const structuralSubcommands: Readonly<Record<string, ReadonlySet<string>>> = {
    hook: new Set(["run", "explain", "lint"]),
    cluster: new Set(["init", "board", "catch-up", "decide", "resume", "reap-duplicates", "sync-roles"]),
    session: new Set(["new", "set", "unset", "title", "complete", "archive", "uncomplete", "unarchive"]),
    identity: new Set(["mint", "set", "ls", "complete", "archive", "uncomplete", "path", "sessions", "lineage", "resolve"]),
  };
  const candidate = argv[0];
  const command = candidate && structuralCommands.has(candidate) ? candidate : null;
  const subcandidate = command ? argv[1] : undefined;
  const allowedSubcommands = command ? structuralSubcommands[command] : undefined;
  const subcommand = subcandidate && allowedSubcommands?.has(subcandidate) ? subcandidate : null;
  return { command, subcommand, flags: flags.join(","), argumentCount: argv.length };
}

/** Create the per-process reporter. File I/O errors are intentionally swallowed. */
export function createCrashReporter(options: CrashReporterOptions = {}): CrashReporter {
  const root = options.root ?? runtimeRoot();
  const now = options.now ?? (() => new Date());
  const runId = (options.runId ?? defaultRunId)();
  const debugEnabled = options.debugEnabled ?? (process.env.CCS_DEBUG === "1" || process.env.CCS_DEBUG === "true");
  const fileLimit = options.maxFileBytes ?? DEFAULT_FILE_LIMIT;
  const recordLimit = options.maxRecordBytes ?? DEFAULT_RECORD_LIMIT;
  const fs = options.fileSystem ?? productionFileSystem;
  let lastBreadcrumb: BreadcrumbRecord | null = null;
  let invocation: CrashFacts | null = null;

  const breadcrumb = (event: string, facts: CrashFacts = {}): void => {
    lastBreadcrumb = {
      kind: "breadcrumb",
      at: now().toISOString(),
      runId,
      event: bounded(redactDiagnosticText(event), 100),
      facts: redactFacts(facts),
    };
    if (!debugEnabled) return;
    appendRotating(fs, root, join(root, "ccs-debug.log"), serializeBounded(lastBreadcrumb, recordLimit), fileLimit);
  };

  return {
    runId,
    invocation(summary): void { invocation = redactFacts(summary); },
    breadcrumb,
    crash(kind, error): void {
      const record: CrashRecord = {
        kind: "crash",
        at: now().toISOString(),
        runId,
        errorKind: kind,
        error: safeError(error, Math.floor(recordLimit / 2)),
        runtime: {
          ccsVersion: pkg.version,
          bunVersion: Bun.version,
          platform: process.platform,
          arch: process.arch,
          stdoutIsTTY: Boolean(process.stdout.isTTY),
          stdinIsTTY: Boolean(process.stdin.isTTY),
          stderrIsTTY: Boolean(process.stderr.isTTY),
          debugEnabled,
        },
        invocation,
        lastBreadcrumb,
      };
      appendRotating(fs, root, join(root, "crash.log"), serializeBounded(record, recordLimit), fileLimit);
    },
  };
}

/** Leave the terminal usable after a fatal error inside the fullscreen TUI. */
function restoreTerminal(): void {
  try {
    process.stdout.write("\x1b[?1049l\x1b[?25h\x1b[0m");
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
  } catch {
    // best effort
  }
}

let installed = false;
let activeReporter: CrashReporter | null = null;

/** Install fatal handlers once and return the per-invocation reporter. */
export function installCrashLog(): CrashReporter {
  if (!activeReporter) activeReporter = createCrashReporter();
  activeReporter.invocation(summarizeArgv(process.argv.slice(2)));
  if (installed) return activeReporter;
  installed = true;
  process.on("uncaughtException", (error) => {
    const err = error instanceof Error ? error : String(error);
    activeReporter?.crash("uncaughtException", err);
    restoreTerminal();
    console.error(`ccs crashed — details in ${CRASH_LOG()}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    const err = error instanceof Error ? error : String(error);
    activeReporter?.crash("unhandledRejection", err);
    restoreTerminal();
    console.error(`ccs crashed (unhandled rejection) — details in ${CRASH_LOG()}`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  });
  return activeReporter;
}

/** The installed process reporter, if startup has created one. */
export function getCrashReporter(): CrashReporter | null {
  return activeReporter;
}
