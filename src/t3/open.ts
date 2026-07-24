import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SessionRow } from "../index/index.ts";
import { type Result } from "../result.ts";
import { encodePath, locateLaunchDir, storageFolderOf, type Located } from "../resume/locate.ts";

const DEFAULT_T3_TIMEOUT_MS = 35_000;
const T3_RESULT_ERROR_CODES = [
  "t3_unavailable",
  "invalid_resume_id",
  "invalid_cwd",
  "source_not_found",
  "provider_unavailable",
  "request_failed",
] as const;

type T3ResultErrorCode = (typeof T3_RESULT_ERROR_CODES)[number];

type JsonValue = boolean | number | string | null | JsonObject | readonly JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** The two values CCS is permitted to provide to the T3 session-open boundary. */
export interface T3OpenRequest {
  readonly resumeId: string;
  readonly cwd: string;
}

/** T3's successful, JSON-mode session-open result. */
export interface T3OpenSuccess {
  readonly kind: "opened";
  readonly threadId: string;
  readonly projectId: string;
  /** True when T3 created the linked thread; false when it opened the existing one. */
  readonly created: boolean;
}

/** A transport or T3-result failure that can be shown directly to the user. */
export interface T3OpenFailure {
  readonly kind: "failure";
  readonly reason:
    | "missing-executable"
    | "spawn-failure"
    | "timeout"
    | "malformed-output"
    | "nonzero"
    | "result-failure";
  readonly message: string;
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly resultCode?: T3ResultErrorCode;
}

export type T3OpenOutcome = T3OpenSuccess | T3OpenFailure;

/** Injectable async seam used by the Ink TUI and its tests. */
export interface T3Opener {
  open(request: T3OpenRequest): Promise<T3OpenOutcome>;
}

/** Minimal spawned-process shape; the seam keeps process control out of Ink event handling. */
export interface T3Process {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface T3OpenClientOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly spawn?: (argv: readonly string[]) => T3Process;
}

interface T3OpenResultError {
  readonly code: T3ResultErrorCode;
  readonly message: string;
}

type T3CliEnvelope =
  | { readonly ok: true; readonly value: { readonly threadId: string; readonly projectId: string; readonly created: boolean } }
  | { readonly ok: false; readonly error: T3OpenResultError };

/** Build the exact argv contract. No shell interpretation or inherited session fields. */
export function buildT3OpenArgv(request: T3OpenRequest, binary = process.env.T3_BIN || "t3"): string[] {
  return [binary, "session", "open", "--resume-id", request.resumeId, "--cwd", request.cwd, "--json"];
}

/**
 * Resolve a launch cwd that is safe to hand to T3. Unlike native Resume, this never guesses a
 * project root or home directory: it accepts only the recorded cwd when its realpath maps to the
 * session storage folder, or an unambiguous, non-exhausted locator result that still verifies.
 */
export function resolveT3OpenCwd(
  row: SessionRow,
  seams: T3CwdResolverSeams = productionT3CwdResolverSeams,
): T3CwdResolution {
  const folder = storageFolderOf(row.path);

  if (row.cwd && isAbsolute(row.cwd)) {
    try {
      const recorded = seams.realpath(row.cwd);
      if (encodePath(recorded) === folder) return { ok: true, cwd: recorded };
    } catch (caught) {
      const error = caught as Error | JsonValue;
      if (!isMissingPathError(error)) return { ok: false, reason: `cannot verify recorded cwd: ${messageOf(error)}` };
    }
  }

  const locatedResult = seams.locateLaunchDir(row.path);
  if (!locatedResult.ok) return { ok: false, reason: `cannot locate session cwd: ${locatedResult.error.message}` };
  if (!locatedResult.value) return { ok: false, reason: "no verified session cwd exists on disk" };

  const located = locatedResult.value;
  if (located.ambiguousWith) {
    return { ok: false, reason: `session cwd is ambiguous (${located.dir} or ${located.ambiguousWith})` };
  }
  if (located.exhausted) return { ok: false, reason: "session cwd search exhausted before it could prove a unique match" };
  if (!isAbsolute(located.dir)) return { ok: false, reason: "located session cwd is not absolute" };

  try {
    const resolved = seams.realpath(located.dir);
    if (encodePath(resolved) !== folder) return { ok: false, reason: "located session cwd no longer matches its storage folder" };
    return { ok: true, cwd: resolved };
  } catch (caught) {
    const error = caught as Error | JsonValue;
    return { ok: false, reason: `cannot verify located session cwd: ${messageOf(error)}` };
  }
}

export interface T3CwdResolverSeams {
  realpath(path: string): string;
  locateLaunchDir(path: string): Result<Located | null, Error>;
}

export type T3CwdResolution = { readonly ok: true; readonly cwd: string } | { readonly ok: false; readonly reason: string };

const productionT3CwdResolverSeams: T3CwdResolverSeams = {
  realpath: (path) => realpathSync(path),
  locateLaunchDir,
};

/** Invoke T3 asynchronously and classify its complete process/result envelope. */
export async function openT3Session(
  request: T3OpenRequest,
  options: T3OpenClientOptions = {},
): Promise<T3OpenOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_T3_TIMEOUT_MS;
  const argv = buildT3OpenArgv(request, options.binary);
  let process: T3Process;

  try {
    process = (options.spawn ?? spawnT3)(argv);
  } catch (caught) {
    const error = caught as Error | JsonValue;
    const message = messageOf(error);
    return {
      kind: "failure",
      reason: isMissingExecutable(message) ? "missing-executable" : "spawn-failure",
      message,
    };
  }

  const completed = Promise.all([
    readProcessStream(process.stdout),
    readProcessStream(process.stderr),
    process.exited,
  ]);
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const outcome = await Promise.race([
    completed.then(
      (result) => ({ kind: "completed" as const, result }),
      (caught) => ({ kind: "failed" as const, error: caught as Error | JsonValue }),
    ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => {
        try {
          process.kill();
        } catch {
          // The process can exit between the timer firing and kill.
        }
        resolve({ kind: "timeout" });
      }, timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (outcome.kind === "timeout") {
    // The caller must regain control at the deadline even if a child retains a pipe or refuses
    // to reap. Keep the settled capture observed so a late rejection is not unhandled.
    void completed.then(() => undefined, () => undefined);
    return { kind: "failure", reason: "timeout", message: `T3 did not respond within ${timeoutMs}ms` };
  }
  if (outcome.kind === "failed") {
    const message = messageOf(outcome.error);
    return {
      kind: "failure",
      reason: isMissingExecutable(message) ? "missing-executable" : "spawn-failure",
      message,
    };
  }

  const [stdout, stderr, exitCode] = outcome.result;
  const envelope = parseT3OpenEnvelope(stdout);
  if (exitCode !== 0) {
    if (envelope && !envelope.ok) return typedFailure(envelope.error, stderr);
    if (isMissingExecutable(stderr)) {
      return { kind: "failure", reason: "missing-executable", message: "T3 executable was not found", exitCode, stderr: trimDiagnostic(stderr) };
    }
    return { kind: "failure", reason: "nonzero", message: `T3 exited with status ${exitCode}`, exitCode, stderr: trimDiagnostic(stderr) };
  }

  if (!envelope) return { kind: "failure", reason: "malformed-output", message: "T3 returned malformed JSON", stderr: trimDiagnostic(stderr) };
  if (!envelope.ok) return typedFailure(envelope.error, stderr);
  return { kind: "opened", threadId: envelope.value.threadId, projectId: envelope.value.projectId, created: envelope.value.created };
}

/** Production seam; callers can inject a deterministic opener in tests. */
export const productionT3Opener: T3Opener = {
  open: (request) => openT3Session(request),
};

function spawnT3(argv: readonly string[]): T3Process {
  const process = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exited: process.exited,
    kill: () => process.kill(),
  };
}

function readProcessStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream ? new Response(stream).text() : Promise.resolve("");
}

function parseT3OpenEnvelope(stdout: string): T3CliEnvelope | null {
  let json: JsonValue;
  try {
    json = JSON.parse(stdout) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(json) || typeof json.ok !== "boolean") return null;

  if (json.ok) {
    const value = json.value;
    if (!isJsonObject(value)) return null;
    const { threadId, projectId, created } = value;
    if (typeof threadId !== "string" || typeof projectId !== "string" || typeof created !== "boolean") return null;
    return { ok: true, value: { threadId, projectId, created } };
  }

  const error = json.error;
  if (!isJsonObject(error)) return null;
  const { code, message } = error;
  if (typeof code !== "string" || typeof message !== "string" || !isT3ResultErrorCode(code)) return null;
  return { ok: false, error: { code, message } };
}

function typedFailure(error: T3OpenResultError, stderr: string): T3OpenFailure {
  return {
    kind: "failure",
    reason: "result-failure",
    message: error.message,
    resultCode: error.code,
    stderr: trimDiagnostic(stderr),
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isT3ResultErrorCode(code: string): code is T3ResultErrorCode {
  return (T3_RESULT_ERROR_CODES as readonly string[]).includes(code);
}

function isMissingPathError(error: Error | JsonValue): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function isMissingExecutable(message: string): boolean {
  return /\bENOENT\b|command not found|no such file or directory/i.test(message);
}

function messageOf(error: Error | JsonValue): string {
  return error instanceof Error ? error.message : String(error);
}

function trimDiagnostic(stderr: string): string | undefined {
  const trimmed = stderr.trim();
  return trimmed ? trimmed : undefined;
}
