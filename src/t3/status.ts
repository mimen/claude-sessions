import type { SessionRow } from "../index/index.ts";
import { CLAUDE_PROVIDER_INSTANCE_ID } from "../catalogue-service/protocol.ts";

const DEFAULT_T3_STATUS_TIMEOUT_MS = 5_000;
const T3_STATUS_RESULT_ERROR_CODES = ["t3_unavailable", "request_failed"] as const;
const T3_ATTACHMENT_STATES = ["attached", "synced", "failed", "desynced"] as const;
const T3_RUNTIME_STATUSES = ["starting", "running", "stopped", "error"] as const;

type T3StatusResultErrorCode = (typeof T3_STATUS_RESULT_ERROR_CODES)[number];
export type T3AttachmentState = (typeof T3_ATTACHMENT_STATES)[number];
export type T3AttachmentRuntimeStatus = (typeof T3_RUNTIME_STATUSES)[number];

type JsonValue = boolean | number | string | null | JsonObject | readonly JsonValue[];

interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface T3AttachmentStatus {
  readonly providerInstanceId: string;
  readonly localSourceHost: string;
  readonly nativeSessionId: string;
  readonly sourceCwd: string;
  readonly sourceId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly state: T3AttachmentState;
  readonly lastSyncedAt: string | null;
  readonly diagnostic: string | null;
  readonly runtimeStatus: T3AttachmentRuntimeStatus | null;
  readonly runtimeLastSeenAt: string | null;
}

export interface T3AttachmentStatusSnapshot {
  readonly protocolVersion: 1;
  readonly generatedAt: string;
  readonly attachments: readonly T3AttachmentStatus[];
}

export type T3AttachmentStatusOutcome =
  | { readonly kind: "snapshot"; readonly snapshot: T3AttachmentStatusSnapshot }
  | {
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
      readonly resultCode?: T3StatusResultErrorCode;
    };

export interface T3AttachmentStatusClient {
  /** Read one process-wide attachment snapshot; callers join it locally rather than probing rows. */
  snapshot(): Promise<T3AttachmentStatusOutcome>;
}

export interface T3StatusProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(): void;
}

export interface T3AttachmentStatusClientOptions {
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly spawn?: (argv: readonly string[]) => T3StatusProcess;
}

interface T3StatusResultError {
  readonly code: T3StatusResultErrorCode;
  readonly message: string;
}

type T3StatusCliEnvelope =
  | { readonly ok: true; readonly value: T3AttachmentStatusSnapshot }
  | { readonly ok: false; readonly error: T3StatusResultError };

export interface T3SourceIdentity {
  readonly providerInstanceId: string;
  readonly localSourceHost: string;
  readonly nativeSessionId: string;
}

export type T3AttachmentIndicator =
  | { readonly kind: "running"; readonly label: string }
  | { readonly kind: "unhealthy"; readonly label: string };

/** Build the exact read-only T3 argv. One invocation returns every active attachment. */
export function buildT3AttachmentStatusArgv(binary = process.env.T3_BIN || "t3"): string[] {
  return [binary, "session", "status", "--json"];
}

/** Invoke T3 once and validate the complete attachment-status snapshot envelope. */
export async function readT3AttachmentStatusSnapshot(
  options: T3AttachmentStatusClientOptions = {},
): Promise<T3AttachmentStatusOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_T3_STATUS_TIMEOUT_MS;
  const argv = buildT3AttachmentStatusArgv(options.binary);
  let process: T3StatusProcess;

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
    void completed.then(() => undefined, () => undefined);
    return {
      kind: "failure",
      reason: "timeout",
      message: `T3 did not return attachment status within ${timeoutMs}ms`,
    };
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
  const envelope = parseT3StatusEnvelope(stdout);
  if (exitCode !== 0) {
    if (envelope && !envelope.ok) return typedFailure(envelope.error, stderr);
    if (isMissingExecutable(stderr)) {
      return {
        kind: "failure",
        reason: "missing-executable",
        message: "T3 executable was not found",
        exitCode,
        stderr: trimDiagnostic(stderr),
      };
    }
    return {
      kind: "failure",
      reason: "nonzero",
      message: `T3 exited with status ${exitCode}`,
      exitCode,
      stderr: trimDiagnostic(stderr),
    };
  }

  if (!envelope) {
    return {
      kind: "failure",
      reason: "malformed-output",
      message: "T3 returned malformed attachment-status JSON",
      stderr: trimDiagnostic(stderr),
    };
  }
  if (!envelope.ok) return typedFailure(envelope.error, stderr);
  return { kind: "snapshot", snapshot: envelope.value };
}

/** Production client seam used by the TUI. */
export const productionT3AttachmentStatusClient: T3AttachmentStatusClient = {
  snapshot: () => readT3AttachmentStatusSnapshot(),
};

/** Stable composite identity shared with T3's attachment join. */
export function t3SourceIdentityKey(identity: T3SourceIdentity): string {
  return `${identity.providerInstanceId}\0${identity.localSourceHost}\0${identity.nativeSessionId}`;
}

/**
 * Join one T3 snapshot to local resumable root rows. Subagents and rows without a native resume id
 * are never eligible, and no T3 storage is accessed.
 */
export function joinT3AttachmentsToRootSessions(
  rows: readonly SessionRow[],
  attachments: readonly T3AttachmentStatus[],
): Map<string, T3AttachmentStatus> {
  const byIdentity = new Map(
    attachments.map((attachment) => [t3SourceIdentityKey(attachment), attachment] as const),
  );
  const bySessionId = new Map<string, T3AttachmentStatus>();
  for (const row of rows) {
    if (row.isSubagent || row.resumeId.trim().length === 0) continue;
    const attachment = byIdentity.get(
      t3SourceIdentityKey({
        providerInstanceId: CLAUDE_PROVIDER_INSTANCE_ID,
        localSourceHost: row.host,
        nativeSessionId: row.resumeId,
      }),
    );
    if (attachment) bySessionId.set(row.sessionId, attachment);
  }
  return bySessionId;
}

/** Convert T3's sync/runtime fields into the two visual states the TUI is allowed to show. */
export function t3AttachmentIndicator(attachment: T3AttachmentStatus): T3AttachmentIndicator {
  const syncHealthy = attachment.state === "attached" || attachment.state === "synced";
  const hasDiagnostic = Boolean(attachment.diagnostic?.trim());
  if (attachment.runtimeStatus === "running" && syncHealthy && !hasDiagnostic) {
    return {
      kind: "running",
      label: `T3 attachment running; sync ${attachment.state}; provider running`,
    };
  }
  return {
    kind: "unhealthy",
    label: `T3 attachment unhealthy; sync ${attachment.state}; provider ${attachment.runtimeStatus ?? "unavailable"}${hasDiagnostic ? "; diagnostic present" : ""}`,
  };
}

function spawnT3(argv: readonly string[]): T3StatusProcess {
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

function parseT3StatusEnvelope(stdout: string): T3StatusCliEnvelope | null {
  let json: JsonValue;
  try {
    json = JSON.parse(stdout) as JsonValue;
  } catch {
    return null;
  }
  if (!isJsonObject(json) || typeof json.ok !== "boolean") return null;

  if (json.ok) {
    const snapshot = parseSnapshot(json.value);
    return snapshot ? { ok: true, value: snapshot } : null;
  }

  const error = json.error;
  if (!isJsonObject(error)) return null;
  const { code, message } = error;
  if (typeof code !== "string" || typeof message !== "string" || !isT3StatusResultErrorCode(code)) {
    return null;
  }
  return { ok: false, error: { code, message } };
}

function parseSnapshot(value: JsonValue | undefined): T3AttachmentStatusSnapshot | null {
  if (!isJsonObject(value)) return null;
  if (value.protocolVersion !== 1 || typeof value.generatedAt !== "string" || !Array.isArray(value.attachments)) {
    return null;
  }
  const attachments: T3AttachmentStatus[] = [];
  for (const item of value.attachments) {
    const attachment = parseAttachment(item);
    if (!attachment) return null;
    attachments.push(attachment);
  }
  return {
    protocolVersion: 1,
    generatedAt: value.generatedAt,
    attachments,
  };
}

function parseAttachment(value: JsonValue): T3AttachmentStatus | null {
  if (!isJsonObject(value)) return null;
  const {
    providerInstanceId,
    localSourceHost,
    nativeSessionId,
    sourceCwd,
    sourceId,
    threadId,
    projectId,
    state,
    lastSyncedAt,
    diagnostic,
    runtimeStatus,
    runtimeLastSeenAt,
  } = value;
  if (
    typeof providerInstanceId !== "string" ||
    typeof localSourceHost !== "string" ||
    typeof nativeSessionId !== "string" ||
    typeof sourceCwd !== "string" ||
    typeof sourceId !== "string" ||
    typeof threadId !== "string" ||
    typeof projectId !== "string" ||
    typeof state !== "string" ||
    !isT3AttachmentState(state) ||
    !isNullableString(lastSyncedAt) ||
    !isNullableString(diagnostic) ||
    !isNullableString(runtimeLastSeenAt) ||
    !(runtimeStatus === null || (typeof runtimeStatus === "string" && isT3RuntimeStatus(runtimeStatus)))
  ) {
    return null;
  }
  return {
    providerInstanceId,
    localSourceHost,
    nativeSessionId,
    sourceCwd,
    sourceId,
    threadId,
    projectId,
    state,
    lastSyncedAt,
    diagnostic,
    runtimeStatus,
    runtimeLastSeenAt,
  };
}

function typedFailure(error: T3StatusResultError, stderr: string): T3AttachmentStatusOutcome {
  return {
    kind: "failure",
    reason: "result-failure",
    resultCode: error.code,
    message: error.message,
    stderr: trimDiagnostic(stderr),
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: JsonValue | undefined): value is string | null {
  return value === null || typeof value === "string";
}

function isT3StatusResultErrorCode(code: string): code is T3StatusResultErrorCode {
  return (T3_STATUS_RESULT_ERROR_CODES as readonly string[]).includes(code);
}

function isT3AttachmentState(state: string): state is T3AttachmentState {
  return (T3_ATTACHMENT_STATES as readonly string[]).includes(state);
}

function isT3RuntimeStatus(status: string): status is T3AttachmentRuntimeStatus {
  return (T3_RUNTIME_STATUSES as readonly string[]).includes(status);
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
