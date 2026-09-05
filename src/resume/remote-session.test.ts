import { expect, test } from "bun:test";
import type { BirthModelId } from "./role-model-launch.ts";
import {
  launchRemoteSession,
  preflightRemoteSession,
  renderRemoteBirthCommand,
  renderRemoteLoginCommand,
  renderRemotePreflightCommand,
  renderRemoteSessionCommand,
  renderSshArgs,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type RemotePreflightRequest,
  type RemoteSessionRequest,
} from "./remote-session.ts";

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: CommandOptions;
}

class FakeRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly results: readonly CommandResult[]) {}

  run(command: string, args: readonly string[], options: CommandOptions): CommandResult {
    this.calls.push({ command, args, options });
    const result = this.results[this.calls.length - 1];
    if (!result) throw new Error(`missing fake result for call ${this.calls.length}`);
    return result;
  }
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    status: 0,
    stdout: "",
    stderr: "",
    error: null,
    ...overrides,
  };
}

function preflightRequest(overrides: Partial<RemotePreflightRequest> = {}): RemotePreflightRequest {
  return {
    targetHost: "Milads-Mac-mini",
    sshAlias: "macmini",
    locationKey: "ccs",
    route: {
      launcher: "claudex",
      model: "gpt-5.6-sol" as BirthModelId,
      launchModel: "gpt-5.6-sol[1m]",
    },
    model: "gpt-5.6-sol" as BirthModelId,
    requiredCapabilities: ["always-on", "shared-vault"],
    ...overrides,
  };
}

function preflightPayload(overrides: Readonly<Record<string, object | string | readonly string[]>> = {}): string {
  return JSON.stringify({
    status: "ready",
    host: "Milads-Mac-mini",
    location: { key: "ccs", name: "CCS", cwd: "/remote/ccs" },
    route: {
      launcher: "claudex",
      model: "gpt-5.6-sol" as BirthModelId,
      launchModel: "gpt-5.6-sol[1m]",
    },
    required_capabilities: ["always-on", "shared-vault"],
    ...overrides,
  });
}

function request(overrides: Partial<RemoteSessionRequest> = {}): RemoteSessionRequest {
  return {
    targetHost: "Milads-Mac-mini",
    sshAlias: "macmini",
    locationKey: "ccs",
    title: "CCS router",
    prompt: "implement routing",
    permissionMode: "acceptEdits",
    model: "gpt-5.6-sol" as BirthModelId,
    requiredCapabilities: ["always-on", "shared-vault"],
    creatorKind: "agent",
    creatorRef: "11111111-1111-4111-8111-111111111111",
    remoteCwd: "/Users/mimen/Programming/Repos/claude-sessions",
    ...overrides,
  };
}

test("SSH preflight uses a login shell with bounded noninteractive connection options", () => {
  expect(renderRemoteLoginCommand("command -v ccs")).toBe(`exec "$SHELL" -lc 'command -v ccs'`);
  expect(renderSshArgs("macmini", "command -v ccs")).toEqual([
    "-o", "ConnectTimeout=5",
    "-o", "BatchMode=yes",
    "macmini",
    `exec "$SHELL" -lc 'command -v ccs'`,
  ]);
});

test("remote preflight carries the exact model route and capabilities into target-side validation", () => {
  const runner = new FakeRunner([commandResult({ stdout: `login noise\n${preflightPayload()}\n` })]);
  const result = preflightRemoteSession(preflightRequest(), runner);

  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.cwd).toBe("/remote/ccs");
  const call = runner.calls[0]!;
  expect(call.command).toBe("ssh");
  expect(call.args).toContain("ConnectTimeout=5");
  expect(call.args).toContain("BatchMode=yes");
  expect(call.args.at(-1)).toContain("command -v ccs");
  expect(call.args.at(-1)).toContain("$HOME/.ccs/locations.toml");
  expect(call.args.at(-1)).toContain("$HOME/.ccs/hosts.toml");
  expect(call.args.at(-1)).toContain("ccs session preflight --top-level --json");
  expect(call.args.at(-1)).toContain("--location=ccs");
  expect(call.args.at(-1)).toContain("--host=Milads-Mac-mini");
  expect(call.args.at(-1)).toContain("--model=gpt-5.6-sol");
  expect(call.args.at(-1)).toContain("--require-capability=always-on");
  expect(call.args.at(-1)).toContain("--require-capability=shared-vault");
  expect(call.options.timeoutMs).toBe(12_000);
});

test("remote preflight carries explicit legacy launchers without inventing a model", () => {
  const command = renderRemotePreflightCommand(preflightRequest({
    route: { launcher: "claude-gpt", model: null, launchModel: null },
    via: "claude-gpt",
    model: null,
  }));
  expect(command).toContain("--via=claude-gpt");
  expect(command).not.toContain("--model=");
  expect(command.match(/--require-capability=/g)).toHaveLength(2);
});

test("remote preflight reports missing prerequisites and timeouts without retrying", () => {
  const missing = new FakeRunner([commandResult({
    status: 21,
    stderr: "CCS_PREFLIGHT_CCS_MISSING\n",
  })]);
  const missingResult = preflightRemoteSession(preflightRequest(), missing);
  expect(missingResult.ok).toBe(false);
  if (!missingResult.ok) expect(missingResult.error.message).toContain("does not expose ccs");
  expect(missing.calls).toHaveLength(1);

  const missingHosts = new FakeRunner([commandResult({
    status: 23,
    stderr: "CCS_PREFLIGHT_HOSTS_MISSING\n",
  })]);
  const missingHostsResult = preflightRemoteSession(preflightRequest(), missingHosts);
  expect(missingHostsResult.ok).toBe(false);
  if (!missingHostsResult.ok) expect(missingHostsResult.error.message).toContain("hosts.toml");
  expect(missingHosts.calls).toHaveLength(1);

  const timeoutError = new Error("spawnSync ssh ETIMEDOUT") as NodeJS.ErrnoException;
  timeoutError.code = "ETIMEDOUT";
  const timedOut = new FakeRunner([commandResult({ status: null, error: timeoutError })]);
  const timeoutResult = preflightRemoteSession(preflightRequest(), timedOut);
  expect(timeoutResult.ok).toBe(false);
  if (!timeoutResult.ok) expect(timeoutResult.error.message).toContain("timed out");
  expect(timedOut.calls).toHaveLength(1);
});

test("remote preflight rejects an SSH alias that reaches the wrong canonical host", () => {
  const runner = new FakeRunner([commandResult({ stdout: preflightPayload({ host: "Milads-M3-2" }) })]);
  const result = preflightRemoteSession(preflightRequest(), runner);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain('reached host "Milads-M3-2"');
});

test("remote preflight accepts canonical host casing drift and surfaces target validation errors", () => {
  const casing = new FakeRunner([commandResult({ stdout: preflightPayload({ host: "milads-MAC-mini" }) })]);
  expect(preflightRemoteSession(preflightRequest(), casing).ok).toBe(true);

  const invalid = new FakeRunner([commandResult({
    status: 2,
    stderr: "ccs session preflight: location ccs cwd is not the Git repository root\n",
  })]);
  const result = preflightRemoteSession(preflightRequest(), invalid);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("cwd is not the Git repository root");
});

test("remote preflight rejects route drift and non-strict receipts", () => {
  const drifted = new FakeRunner([commandResult({
    stdout: preflightPayload({
      route: { launcher: "claude", model: "claude-fable-5", launchModel: "claude-fable-5" },
    }),
  })]);
  const drift = preflightRemoteSession(preflightRequest(), drifted);
  expect(drift.ok).toBe(false);
  if (!drift.ok) expect(drift.error.message).toContain("resolved route");

  const extraField = new FakeRunner([commandResult({ stdout: preflightPayload({ unexpected: "stale" }) })]);
  const strict = preflightRemoteSession(preflightRequest(), extraField);
  expect(strict.ok).toBe(false);
  if (!strict.ok) expect(strict.error.message).toContain("invalid receipt");
});

test("unknown launchers, stale models, and missing capabilities fail in one target preflight", () => {
  for (const detail of [
    'unknown launcher "old-gateway"',
    'unsupported --model "gpt-5.7-sol"',
    'lacks required capability "browser-auth"',
  ]) {
    const runner = new FakeRunner([commandResult({
      status: 2,
      stderr: `ccs session preflight: ${detail}\n`,
    })]);
    const result = preflightRemoteSession(preflightRequest(), runner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(detail);
    expect(runner.calls).toHaveLength(1);
  }
});

test("remote managed birth quotes provenance and dash-leading prompts without a parent", () => {
  const command = renderRemoteBirthCommand(request({
    prompt: "--review 'quoted' work",
    title: "Router's remote run",
  }));
  expect(command).toContain("CCS_CREATOR_KIND=agent");
  expect(command).toContain("CCS_CREATOR_REF=11111111-1111-4111-8111-111111111111");
  expect(command).toContain("ccs session new --top-level --inline");
  expect(command).toContain("'--prompt=--review '\\''quoted'\\'' work'");
  expect(command).toContain("--model=gpt-5.6-sol");
  expect(command.match(/--require-capability=/g)).toHaveLength(2);
  expect(command).toContain("--require-capability=always-on");
  expect(command).toContain("--require-capability=shared-vault");
  expect(command).not.toContain("--child-of");
  expect(command).not.toContain("CCS_LAUNCH_PARENT_SESSION_ID");
  expect(command).not.toMatch(/(^|\s)claude(?:-native|-gpt)?(\s|$)/);
});

test("cmux SSH placement returns a pending receipt without waiting for the body", () => {
  const runner = new FakeRunner([commandResult({ stdout: "OK workspace:417\n" })]);
  const outcome = launchRemoteSession(request(), runner);
  expect(outcome.ok).toBe(true);
  expect(outcome.receipt).toMatchObject({
    status: "workspace_created",
    session_id: "pending",
    workspace_ref: "workspace:417",
    host: "Milads-Mac-mini",
    location: "ccs",
  });
  expect(outcome.receipt.uncertainty).toContain("not yet receipt-confirmed");

  const call = runner.calls[0]!;
  expect(call.command).toBe("cmux");
  expect(call.args.slice(0, 2)).toEqual(["ssh", "macmini"]);
  expect(call.args).toContain("--no-focus");
  expect(call.args).toContain("ConnectTimeout=5");
  expect(call.args).toContain("BatchMode=yes");
  expect(call.options.environment?.CMUX_QUIET).toBe("1");
});

test("cmux failure preserves any workspace reference and states uncertainty without retry", () => {
  const timeoutError = new Error("cmux timed out") as NodeJS.ErrnoException;
  timeoutError.code = "ETIMEDOUT";
  const runner = new FakeRunner([commandResult({
    status: null,
    stdout: "OK workspace:418\n",
    error: timeoutError,
  })]);
  const outcome = launchRemoteSession(request(), runner);
  expect(outcome.ok).toBe(false);
  expect(outcome.receipt.status).toBe("workspace_uncertain");
  expect(outcome.receipt.workspace_ref).toBe("workspace:418");
  expect(outcome.receipt.session_id).toBe("pending");
  expect(outcome.receipt.uncertainty).toContain("before any retry");
  expect(runner.calls).toHaveLength(1);
});
