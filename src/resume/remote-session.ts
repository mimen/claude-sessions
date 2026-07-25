import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { CreatorKind } from "../catalogue/db.ts";
import { type Result, err, ok } from "../result.ts";
import { shellQuote } from "./command.ts";
import type { BirthModelId } from "./role-model-launch.ts";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | null;
}

export interface CommandOptions {
  readonly timeoutMs: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): CommandResult;
}

const DEFAULT_RUNNER: CommandRunner = {
  run(command, args, options) {
    const result = spawnSync(command, [...args], {
      encoding: "utf8",
      timeout: options.timeoutMs,
      env: options.environment ? { ...options.environment } : process.env,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ?? null,
    };
  },
};

const RemoteLocationPayloadSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
  current_host: z.string().min(1),
  host_eligible: z.boolean(),
  validation_error: z.string().nullable().optional(),
}).passthrough();

export interface RemotePreflightRequest {
  readonly targetHost: string;
  readonly sshAlias: string;
  readonly locationKey: string;
}

export interface RemotePreflight {
  readonly targetHost: string;
  readonly locationKey: string;
  readonly locationName: string;
  readonly cwd: string;
}

export interface RemoteSessionRequest extends RemotePreflightRequest {
  readonly title: string;
  readonly prompt?: string;
  readonly permissionMode?: string;
  readonly via?: string;
  readonly model?: BirthModelId;
  readonly requiredCapabilities?: readonly string[];
  readonly creatorKind: CreatorKind;
  readonly creatorRef: string | null;
  readonly remoteCwd: string;
}

export interface PendingRemoteReceipt {
  readonly status: "workspace_created" | "workspace_uncertain";
  readonly session_id: "pending";
  readonly host: string;
  readonly location: string;
  readonly cwd: string;
  readonly workspace_ref: string | null;
  readonly uncertainty: string;
}

export type RemoteLaunchOutcome =
  | { readonly ok: true; readonly receipt: PendingRemoteReceipt }
  | { readonly ok: false; readonly receipt: PendingRemoteReceipt; readonly error: Error };

function errorDetail(result: CommandResult): string {
  const pieces = [result.stderr.trim(), result.stdout.trim(), result.error?.message ?? ""].filter(Boolean);
  return pieces.join("; ") || `exit status ${String(result.status)}`;
}

function timedOut(result: CommandResult): boolean {
  return (result.error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT";
}

function sameCanonicalHost(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

function extractJsonObject(output: string): object | null {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first === -1 || last < first) return null;
  try {
    return JSON.parse(output.slice(first, last + 1)) as object;
  } catch {
    return null;
  }
}

/** Run one command through the remote account's login shell. */
export function renderRemoteLoginCommand(command: string): string {
  return `exec "$SHELL" -lc ${shellQuote(command)}`;
}

/** Hang-proof SSH argv shared by preflight and receipt probes. */
export function renderSshArgs(sshAlias: string, remoteCommand: string): string[] {
  return [
    "-o", "ConnectTimeout=5",
    "-o", "BatchMode=yes",
    sshAlias,
    renderRemoteLoginCommand(remoteCommand),
  ];
}

/** Verify the remote managed-birth prerequisites without creating a workspace or session. */
export function preflightRemoteSession(
  request: RemotePreflightRequest,
  runner: CommandRunner = DEFAULT_RUNNER,
): Result<RemotePreflight> {
  const locationArg = shellQuote(request.locationKey);
  const hostArg = shellQuote(request.targetHost);
  const check = [
    "if ! command -v ccs >/dev/null 2>&1; then printf '%s\\n' CCS_PREFLIGHT_CCS_MISSING >&2; exit 21; fi",
    "if ! test -r \"$HOME/.ccs/locations.toml\"; then printf '%s\\n' CCS_PREFLIGHT_REGISTRY_MISSING >&2; exit 22; fi",
    "if ! test -r \"$HOME/.ccs/hosts.toml\"; then printf '%s\\n' CCS_PREFLIGHT_HOSTS_MISSING >&2; exit 23; fi",
    `exec ccs location show ${locationArg} --json --host ${hostArg}`,
  ].join("; ");
  const result = runner.run("ssh", renderSshArgs(request.sshAlias, check), { timeoutMs: 12_000 });
  if (timedOut(result)) return err(new Error(`SSH preflight timed out for host "${request.targetHost}"`));
  if (result.status !== 0) {
    const detail = errorDetail(result);
    if (detail.includes("CCS_PREFLIGHT_CCS_MISSING")) {
      return err(new Error(`remote host "${request.targetHost}" does not expose ccs in its login shell`));
    }
    if (detail.includes("CCS_PREFLIGHT_REGISTRY_MISSING")) {
      return err(new Error(`remote host "${request.targetHost}" cannot read ~/.ccs/locations.toml`));
    }
    if (detail.includes("CCS_PREFLIGHT_HOSTS_MISSING")) {
      return err(new Error(`remote host "${request.targetHost}" cannot read ~/.ccs/hosts.toml`));
    }
    return err(new Error(`remote location preflight failed on "${request.targetHost}": ${detail}`));
  }

  const json = extractJsonObject(result.stdout);
  const parsed = RemoteLocationPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return err(new Error(`remote location preflight returned an invalid receipt for "${request.targetHost}"`));
  }
  if (parsed.data.key !== request.locationKey) {
    return err(new Error(
      `remote location preflight returned key "${parsed.data.key}", expected "${request.locationKey}"`,
    ));
  }
  if (!parsed.data.host_eligible) {
    const detail = parsed.data.validation_error?.trim() || `location "${request.locationKey}" is not eligible`;
    return err(new Error(`remote location validation failed on "${request.targetHost}": ${detail}`));
  }
  if (!sameCanonicalHost(parsed.data.current_host, request.targetHost)) {
    return err(new Error(
      `SSH alias "${request.sshAlias}" reached host "${parsed.data.current_host}", expected "${request.targetHost}"`,
    ));
  }
  return ok({
    targetHost: request.targetHost,
    locationKey: request.locationKey,
    locationName: parsed.data.name,
    cwd: parsed.data.cwd,
  });
}

/** Render the one remote managed birth. Every value is a separately quoted shell word. */
export function renderRemoteBirthCommand(request: RemoteSessionRequest): string {
  const assignments = [`CCS_CREATOR_KIND=${shellQuote(request.creatorKind)}`];
  if (request.creatorRef) assignments.push(`CCS_CREATOR_REF=${shellQuote(request.creatorRef)}`);

  const args = [
    "ccs",
    "session",
    "new",
    "--top-level",
    "--inline",
    `--location=${request.locationKey}`,
  ];
  if (request.title) args.push(`--title=${request.title}`);
  if (request.prompt !== undefined) args.push(`--prompt=${request.prompt}`);
  if (request.permissionMode) args.push(`--permission-mode=${request.permissionMode}`);
  if (request.via) args.push(`--via=${request.via}`);
  if (request.model) args.push(`--model=${request.model}`);
  for (const capability of request.requiredCapabilities ?? []) {
    args.push(`--require-capability=${capability}`);
  }

  return `${assignments.join(" ")} ${args.map(shellQuote).join(" ")}`;
}

export function renderRemoteSessionCommand(request: RemoteSessionRequest): string {
  return renderRemoteLoginCommand(renderRemoteBirthCommand(request));
}

function workspaceRef(output: string): string | null {
  return output.match(/workspace:[A-Za-z0-9-]+/)?.[0] ?? null;
}

/** Create exactly one remote cmux workspace. Session identity remains pending until a stronger receipt lands. */
export function launchRemoteSession(
  request: RemoteSessionRequest,
  runner: CommandRunner = DEFAULT_RUNNER,
): RemoteLaunchOutcome {
  const result = runner.run("cmux", [
    "ssh",
    request.sshAlias,
    "--name", request.title,
    "--command", renderRemoteSessionCommand(request),
    "--ssh-option", "ConnectTimeout=5",
    "--ssh-option", "BatchMode=yes",
    "--no-focus",
  ], {
    timeoutMs: 12_000,
    environment: { ...process.env, CMUX_QUIET: "1" },
  });
  const ref = workspaceRef(`${result.stdout}\n${result.stderr}`);
  const uncertainty = ref
    ? "Remote workspace creation succeeded, but session reservation and prompt delivery are not yet receipt-confirmed. Inspect this workspace before any retry."
    : "Remote workspace creation, session reservation, and prompt delivery are unconfirmed. Do not retry automatically.";
  const receipt: PendingRemoteReceipt = {
    status: result.status === 0 && ref ? "workspace_created" : "workspace_uncertain",
    session_id: "pending",
    host: request.targetHost,
    location: request.locationKey,
    cwd: request.remoteCwd,
    workspace_ref: ref,
    uncertainty,
  };

  if (result.status !== 0 || !ref) {
    const detail = timedOut(result)
      ? `cmux ssh timed out for host "${request.targetHost}"`
      : `cmux ssh failed for host "${request.targetHost}": ${errorDetail(result)}`;
    return { ok: false, receipt, error: new Error(detail) };
  }
  return { ok: true, receipt };
}
