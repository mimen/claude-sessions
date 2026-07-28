import { expect, test, afterEach, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, getRow, lifecycleOf, identityKeyOf, setCluster, stampPrFacts, setWorkUnitId, getMeta, _resetRoleResumeCache } from "../catalogue/db.ts";
import { getIdentity } from "../catalogue/identities.ts";
import { resolveWorkUnit } from "../catalogue/resolve-work-unit.ts";
import {
  applyLocationDefaults,
  buildLaunchArgv,
  buildLocalLaunchReceipt,
  inlineLaunchEnvironment,
  inlineLaunchOutcome,
  launchEnvironmentOverrides,
  newSession,
  parseOpts,
  preflightNewSession,
  resolveNewSessionPermissionMode,
  writeSessionMetadata,
  type NewSessionOpts,
  type RemoteSessionDependencies,
} from "./new-session.ts";

const NOW = "2026-07-08T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  _resetRoleResumeCache();
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.CCS_CONFIG_ROOT; delete process.env.CCS_ROOT;
  delete process.env.CCS_CREATOR_KIND; delete process.env.CCS_CREATOR_REF;
  delete process.env.CCS_LAUNCH_CREATOR_KIND; delete process.env.CCS_LAUNCH_CREATOR_REF;
  delete process.env.CCS_LAUNCH_PARENT_SESSION_ID;
  delete process.env.CMUX_BIN;
});
/** Temp config+runtime roots with a pr-anchored role, for the work-unit spawn path. */
function withPrRole(): void {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-ns-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-ns-rt-"));
  roots.push(cfg, rt);
  const dir = join(cfg, "clusters", "pr-watch", "roles", "pr-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'work_unit = "pr"\n');
  process.env.CCS_CONFIG_ROOT = cfg; process.env.CCS_ROOT = rt;
  _resetRoleResumeCache();
}

function withEventRole(): string {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-ns-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-ns-rt-"));
  roots.push(cfg, rt);
  const dir = join(cfg, "clusters", "event-watch", "roles", "event-worker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'kind = "session"\nwork_unit = "none"\n');
  mkdirSync(join(rt, "cache"), { recursive: true });
  process.env.CCS_CONFIG_ROOT = cfg; process.env.CCS_ROOT = rt;
  _resetRoleResumeCache();
  return rt;
}

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init", "-q", cwd]);
}

function configureTestLocation(
  runtimeRoot: string,
  cwd: string,
  route: { harness: string; model: string } | null,
  eligibleHost = "Milads-M3-2",
): void {
  initGitRepo(cwd);
  const routeToml = route
    ? `default_harness = "${route.harness}"\ndefault_model = "${route.model}"\n`
    : "";
  const registry = join(runtimeRoot, "locations.toml");
  writeFileSync(registry, `version = 1\ndefault_host = "${eligibleHost}"\n\n[[location]]\nkey = "ccs"\nname = "CCS"\ncwd = "${cwd}"\nkind = "repo"\neligible_hosts = ["${eligibleHost}"]\npreferred_host = "${eligibleHost}"\n${routeToml}status = "active"\n`);
  writeFileSync(join(runtimeRoot, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n[routing]\nregistry = "${registry}"\n`);
}

function configureTestHosts(runtimeRoot: string, status: "active" | "retired" = "active"): void {
  writeFileSync(join(runtimeRoot, "hosts.toml"), `version = 1\n\n[[host]]\nname = "Milads-Mac-mini"\nssh_alias = "macmini"\ncapabilities = ["always-on", "headless", "ssh", "shared-vault"]\nstatus = "${status}"\n`);
}

function configureLocalTestHost(runtimeRoot: string): void {
  writeFileSync(join(runtimeRoot, "hosts.toml"), `version = 1\n\n[[host]]\nname = "Milads-M3-2"\nssh_alias = "milads-m3"\ncapabilities = ["interactive-gui", "local-user-state", "browser-auth", "shared-vault"]\nstatus = "active"\n`);
}

function configureFakeCmux(runtimeRoot: string, outcome: "success" | "failure"): string {
  const executable = join(runtimeRoot, `fake-cmux-${outcome}`);
  const body = outcome === "success"
    ? `#!/usr/bin/env bash
command=''
while (($#)); do
  if [[ "$1" == "--command" ]]; then
    shift
    command="$1"
  fi
  shift
done
if [[ "$command" == *" && /usr/bin/env "* ]]; then
  setup="\${command%% && /usr/bin/env *}"
  /bin/bash -c "\${setup} && true)" || exit 1
fi
printf '%s\\n' 'OK workspace:777'
`
    : "#!/usr/bin/env bash\nprintf '%s\\n' 'cmux unavailable' >&2\nexit 1\n";
  writeFileSync(executable, body);
  chmodSync(executable, 0o755);
  return executable;
}

function captureJsonReceipt(run: () => number): { readonly exitCode: number; readonly receipt: Record<string, unknown> } {
  const messages: string[] = [];
  const log = spyOn(console, "log").mockImplementation((message?: unknown): void => {
    messages.push(String(message));
  });
  try {
    const exitCode = run();
    expect(messages).toHaveLength(1);
    return { exitCode, receipt: JSON.parse(messages[0]!) as Record<string, unknown> };
  } finally {
    log.mockRestore();
  }
}

function parsedOpts(args: string[]): NewSessionOpts {
  const result = parseOpts(args);
  if (!result.ok) throw result.error;
  return result.value;
}

test("supersede-on-spawn: a new worker archives prior sessions of the same identity (ADR-0073)", () => {
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    // ADR-0089 v33: siblings on the same PR share ONE identity_key. Seed the OLD session
    // attached to it via the identity FK; writeSessionMetadata for a new sid on the same
    // identity should archive the old.
    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeSessionMetadata(db, oldId, parsedOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("idle");

    // Spawn a FRESH worker for the same PR.
    const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeSessionMetadata(db, newId, parsedOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // the old one is archived (expired) with a pointer to who superseded it
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("archived");
    expect(getMeta(getRow(db, oldId)!, "superseded_by")).toBe(newId);
    // the new one is idle + shares the identity_key
    expect(lifecycleOf(getRow(db, newId)!)).toBe("idle");
    expect(getRow(db, newId)!.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#12080");
  } finally {
    db.close();
  }
});

test("supersede-on-spawn keeps the fleet identity alive (acceptance #9)", () => {
  // The old session is archived (superseded) but the identity itself must
  // stay active — the WORK UNIT (this PR) is still in flight, just being
  // taken over by a fresh worker. If the identity flipped archived=1 here
  // the whole PR would vanish from the board.
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    const key = "pr-watch:pr-agent:heroku/dashboard#12080";

    // 1st worker
    const oldId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeSessionMetadata(db, oldId, parsedOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // 2nd worker on the same PR
    const newId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    writeSessionMetadata(db, newId, parsedOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);

    // Old session is archived + points at the successor.
    expect(lifecycleOf(getRow(db, oldId)!)).toBe("archived");
    expect(getMeta(getRow(db, oldId)!, "superseded_by")).toBe(newId);
    // New session is live and attached to the same identity.
    expect(lifecycleOf(getRow(db, newId)!)).toBe("idle");
    expect(getRow(db, newId)!.identityKey).toBe(key);

    // THE ACCEPTANCE CHECK: the shared fleet identity itself stays
    // active (archived=false, completed=false). If mintIdentity's idempotent
    // no-op ever regressed into 'reset flags on re-mint', this would flip.
    const id = getIdentity(db, key)!;
    expect(id.archived).toBe(false);
    expect(id.completed).toBe(false);
  } finally {
    db.close();
  }
});

test("parseOpts: reads every flag, --role and --skill are synonyms", () => {
  const o = parsedOpts([
    "--cluster", "pr-watch",
    "--role", "pr-agent",
    "--project", "metered-pricing",
    "--key", "heroku_dashboard-12080",
    "--title", "#12080 Fix navbar",
    "--parent", "aaaa",
    "--cwd", "/tmp",
    "--prompt", "go build it",
    "--permission-mode", "acceptEdits",
    "--print-id",
  ]);
  expect(o.cluster).toBe("pr-watch");
  expect(o.role).toBe("pr-agent");
  expect(o.project).toBe("metered-pricing");
  expect(o.key).toBe("heroku_dashboard-12080");
  expect(o.title).toBe("#12080 Fix navbar");
  expect(o.parent).toBe("aaaa");
  expect(o.cwd).toBe("/tmp");
  expect(o.prompt).toBe("go build it");
  expect(o.permissionMode).toBe("acceptEdits");
  expect(o.printId).toBe(true);
});

test("ADR-0094: parseOpts rejects a --permission-mode Claude Code wouldn't accept", () => {
  const bad = parseOpts(["--permission-mode", "bypass"]);
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.message).toContain("permission_mode must be one of");
});

test("ADR-0094: birth precedence — explicit flag > role > cluster > the legacy loop default", () => {
  const loop = { kind: "loop" as const, permissionMode: null };
  const loopWithPolicy = { kind: "loop" as const, permissionMode: "plan" };
  const worker = { kind: "session" as const, permissionMode: null };
  const bypass = { permissionMode: "bypassPermissions" };
  const noPolicy = { permissionMode: null };

  // An operator typing the flag always wins — policy is a default, not a cage.
  expect(resolveNewSessionPermissionMode("manual", loopWithPolicy, bypass)).toBe("manual");
  // Role above cluster.
  expect(resolveNewSessionPermissionMode(undefined, loopWithPolicy, bypass)).toBe("plan");
  // Cluster policy applies when the role is silent — and BEATS the historical loop default,
  // which existed only because nothing could declare a posture.
  expect(resolveNewSessionPermissionMode(undefined, loop, bypass)).toBe("bypassPermissions");
  // With no declared policy anywhere, an unattended loop keeps its acceptEdits default…
  expect(resolveNewSessionPermissionMode(undefined, loop, noPolicy)).toBe("acceptEdits");
  // …and a plain worker keeps launching with no flag at all.
  expect(resolveNewSessionPermissionMode(undefined, worker, noPolicy)).toBeNull();
  expect(resolveNewSessionPermissionMode(undefined, null, null)).toBeNull();
});

test("parseOpts: --skill is accepted as an alias for --role", () => {
  expect(parsedOpts(["--skill", "pr-watch-eval"]).role).toBe("pr-watch-eval");
});

test("parseOpts: reads curated location and canonical host placement", () => {
  const opts = parsedOpts(["--location", "ccs", "--host", "Milads-Mac-mini"]);
  expect(opts.location).toBe("ccs");
  expect(opts.host).toBe("Milads-Mac-mini");
});

test("parseOpts: reads exact model, repeated capabilities, and JSON receipt mode", () => {
  const opts = parsedOpts([
    "--model=gpt-5.6-terra",
    "--require-capability", "always-on",
    "--require-capability=shared-vault",
    "--json",
  ]);
  expect(opts.model).toBe("gpt-5.6-terra");
  expect(opts.requiredCapabilities).toEqual(["always-on", "shared-vault"]);
  expect(opts.json).toBe(true);
});

test("parseOpts: rejects missing values instead of dropping safety constraints", () => {
  const beforeModel = parseOpts(["--require-capability", "--model", "gpt-5.6-sol"]);
  expect(beforeModel.ok).toBe(false);
  if (!beforeModel.ok) expect(beforeModel.error.message).toContain("--require-capability requires a value");

  const trailing = parseOpts(["--model"]);
  expect(trailing.ok).toBe(false);
  if (!trailing.ok) expect(trailing.error.message).toContain("--model requires a value");

  const empty = parseOpts(["--location="]);
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.error.message).toContain("--location requires a value");
});

test("applyLocationDefaults resolves cwd, title, and route metadata before birth", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-location-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  initGitRepo(cwd);
  const registry = join(root, "locations.toml");
  writeFileSync(registry, `version = 1\ndefault_host = "Milads-Mac-mini"\n\n[[location]]\nkey = "ccs"\nname = "CCS"\ncwd = "${cwd}"\nkind = "repo"\neligible_hosts = ["Milads-M3-2", "Milads-Mac-mini"]\npreferred_host = "Milads-Mac-mini"\ndefault_harness = "claude-gpt"\ndefault_model = "gpt-5.6-sol"\nstatus = "active"\n`);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n[routing]\nregistry = "${registry}"\n`);
  process.env.CCS_ROOT = root;

  const opts = parsedOpts(["--location", "ccs", "--top-level"]);
  const applied = applyLocationDefaults(opts);
  expect(applied.ok).toBe(true);
  expect(opts.cwd).toBe(realpathSync(cwd));
  expect(opts.title).toBe("CCS");
  expect(opts.via).toBeUndefined();
  expect(opts.locationKey).toBe("ccs");
  expect(opts.locationDefaultModel).toBe("gpt-5.6-sol");
  if (applied.ok) expect(applied.value?.defaultHarness).toBe("claude-gpt");
});

test("applyLocationDefaults inherits the registry-wide exact route", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-root-default-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  initGitRepo(cwd);
  const registry = join(root, "locations.toml");
  writeFileSync(registry, `version = 1\ndefault_host = "Milads-M3-2"\ndefault_harness = "claude-gpt"\ndefault_model = "gpt-5.6-sol"\n\n[[location]]\nkey = "ccs"\nname = "CCS"\ncwd = "${cwd}"\nkind = "repo"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-M3-2"\nstatus = "active"\n`);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n[routing]\nregistry = "${registry}"\n`);
  process.env.CCS_ROOT = root;

  const opts = parsedOpts(["--location=ccs", "--top-level"]);
  const applied = applyLocationDefaults(opts);
  expect(applied.ok).toBe(true);
  expect(opts.locationDefaultHarness).toBe("claude-gpt");
  expect(opts.locationDefaultModel).toBe("gpt-5.6-sol");
});

test("applyLocationDefaults rejects explicit cwd conflicts", () => {
  const opts = parsedOpts(["--location", "ccs", "--cwd", "/tmp"]);
  const applied = applyLocationDefaults(opts);
  expect(applied.ok).toBe(false);
  if (applied.ok) return;
  expect(applied.error.message).toContain("cannot be combined");
});

test("parseOpts: reads explicit identity-at-birth flags", () => {
  const opts = parsedOpts([
    "--identity=event-watch:event-worker:gio",
    "--cluster=event-watch",
    "--role=/event-worker",
    "--top-level",
    "--print-id",
  ]);
  expect(opts.identity).toBe("event-watch:event-worker:gio");
  expect(opts.cluster).toBe("event-watch");
  expect(opts.role).toBe("/event-worker");
  expect(opts.topLevel).toBe(true);
  expect(opts.printId).toBe(true);
});

test("parseOpts: does not reinterpret an option-shaped prompt as identity", () => {
  const opts = parsedOpts(["--prompt", "--identity=not-a-flag", "--cluster=event-watch"]);
  expect(opts.prompt).toBe("--identity=not-a-flag");
  expect(opts.identity).toBeUndefined();
  expect(opts.cluster).toBe("event-watch");
});

test("parseOpts: does not reinterpret boolean flags inside a prompt", () => {
  expect(parsedOpts(["--prompt", "--top-level"]).topLevel).toBe(false);
  expect(parsedOpts(["--prompt", "--print-id"]).printId).toBe(false);
  expect(parsedOpts(["--prompt", "--inline"]).inline).toBe(false);
});

test("structured local receipts preserve the full recoverable session identity", () => {
  const success = buildLocalLaunchReceipt({
    id: "11111111-1111-4111-8111-111111111111",
    title: "Fix checkout UI",
    host: "Milads-M3-2",
    location: "auf-web",
    cwd: "/tmp/auf-web",
    harness: "claude",
    model: "claude-fable-5",
    launchModel: "claude-fable-5",
    outcome: { exitCode: 0, workspaceRef: "workspace:501", error: null },
  });
  expect(success).toMatchObject({
    status: "launched",
    session_id: "11111111-1111-4111-8111-111111111111",
    model: "claude-fable-5",
    workspace_ref: "workspace:501",
    error: null,
  });

  const failed = buildLocalLaunchReceipt({
    id: "22222222-2222-4222-8222-222222222222",
    title: "Recoverable birth",
    host: "Milads-M3-2",
    location: null,
    cwd: "/tmp/project",
    harness: "claude-gpt",
    model: "gpt-5.6-sol",
    launchModel: "gpt-5.6-sol[1m]",
    outcome: { exitCode: 1, workspaceRef: null, error: "cmux unavailable" },
  });
  expect(failed).toMatchObject({
    status: "workspace_failed",
    session_id: "22222222-2222-4222-8222-222222222222",
    workspace_ref: null,
    error: "cmux unavailable",
  });
});

test("newSession: production JSON receipt reports a successful detached birth", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-json-success-"));
  roots.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n`);
  process.env.CCS_ROOT = root;
  process.env.CMUX_BIN = configureFakeCmux(root, "success");

  const result = captureJsonReceipt(() => newSession([
    "--top-level",
    `--cwd=${root}`,
    "--title=Production receipt",
    "--model=gpt-5.6-sol",
    "--json",
  ]));
  expect(result.exitCode).toBe(0);
  expect(result.receipt).toMatchObject({
    status: "launched",
    title: "Production receipt",
    host: "Milads-M3-2",
    location: null,
    cwd: root,
    harness: "claude-gpt",
    model: "gpt-5.6-sol",
    launch_model: "gpt-5.6-sol[1m]",
    workspace_ref: "workspace:777",
    error: null,
  });
  expect(result.receipt.session_id).toMatch(/^[0-9a-f-]{36}$/);
});

test("newSession: production JSON failure receipt retains the recoverable full UUID", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-json-failure-"));
  roots.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n`);
  process.env.CCS_ROOT = root;
  process.env.CMUX_BIN = configureFakeCmux(root, "failure");

  const result = captureJsonReceipt(() => newSession([
    "--top-level",
    `--cwd=${root}`,
    "--title=Recoverable receipt",
    "--model=gpt-5.6-sol",
    "--json",
  ]));
  expect(result.exitCode).toBe(1);
  expect(result.receipt).toMatchObject({
    status: "workspace_failed",
    title: "Recoverable receipt",
    harness: "claude-gpt",
    model: "gpt-5.6-sol",
    workspace_ref: null,
  });
  expect(result.receipt.session_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.receipt.error).toContain(String(result.receipt.session_id));

  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(getRow(db, String(result.receipt.session_id))).not.toBeNull();
  } finally {
    db.close();
  }
});

test("inline launch outcome distinguishes startup failures from launched failures", () => {
  expect(inlineLaunchOutcome(null, undefined)).toEqual({ exitCode: 127, startupFailed: true });
  expect(inlineLaunchOutcome(1, undefined)).toEqual({ exitCode: 1, startupFailed: false });
  expect(inlineLaunchOutcome(null, "SIGKILL")).toEqual({ exitCode: 137, startupFailed: false });
});

test("managed launch environments force the shim and consume one-birth creator declarations", () => {
  process.env.CCS_CREATOR_KIND = "automation";
  process.env.CCS_CREATOR_REF = "stale-daemon";
  process.env.CCS_LAUNCH_CREATOR_KIND = "agent";
  process.env.CCS_LAUNCH_CREATOR_REF = "stale-session";
  process.env.CCS_LAUNCH_PARENT_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const opts = {
    printId: false,
    inline: true,
    creatorKind: "automation" as const,
    creatorRef: "imsg-server",
    parent: "11111111-1111-4111-8111-111111111111",
  };

  const shimDirectory = join(process.env.HOME ?? "/tmp", ".ccs", "bin");
  const overrides = launchEnvironmentOverrides(opts, { PATH: `/raw-claude:${shimDirectory}:/usr/bin` });
  expect(overrides.PATH?.split(":")[0]).toBe(shimDirectory);
  expect(overrides.CCS_CREATOR_KIND).toBe("");
  expect(overrides.CCS_CREATOR_REF).toBe("");
  expect(overrides.CCS_LAUNCH_CREATOR_KIND).toBe("automation");
  expect(overrides.CCS_LAUNCH_CREATOR_REF).toBe("imsg-server");
  expect(overrides.CCS_LAUNCH_PARENT_SESSION_ID).toBe(opts.parent);

  const inline = inlineLaunchEnvironment(opts, { PATH: `/raw-claude:${shimDirectory}:/usr/bin` });
  expect(inline.PATH?.split(":")[0]).toBe(shimDirectory);
  expect(inline.CCS_CREATOR_KIND).toBeUndefined();
  expect(inline.CCS_CREATOR_REF).toBeUndefined();
  expect(inline.CCS_LAUNCH_CREATOR_KIND).toBe("automation");
  expect(inline.CCS_LAUNCH_CREATOR_REF).toBe("imsg-server");
  expect(inline.CCS_LAUNCH_PARENT_SESSION_ID).toBe(opts.parent);
});

test("writeSessionMetadata: explicit identity attaches without minting or inferring work", () => {
  const db = openCatalogue(":memory:");
  try {
    const key = "event-watch:event-worker:gio";
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
    const id = "11111111-1111-4111-8111-111111111111";
    writeSessionMetadata(db, id, parsedOpts([
      `--identity=${key}`, "--cluster=event-watch", "--role=/event-worker", "--title=Gio", "--top-level",
    ]), NOW);
    const row = getRow(db, id)!;
    expect(row.identityKey).toBe(key);
    expect(row.resumeId).toBe(id);
    expect(row.customTitle).toBe("Gio");
    expect(row.parentSessionId).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: explicit identity failure leaves no partial session row", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(() => writeSessionMetadata(db, id, parsedOpts([
      "--identity=event-watch:event-worker:missing", "--cluster=event-watch", "--role=event-worker", "--title=must not persist",
    ]), NOW)).toThrow("does not exist");
    expect(getRow(db, id)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: explicit metadata rolls back if a later write fails", () => {
  const db = openCatalogue(":memory:");
  try {
    const key = "event-watch:event-worker:gio";
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
    db.exec(`
      CREATE TRIGGER abort_explicit_title
      BEFORE UPDATE OF custom_title ON catalogue
      WHEN NEW.custom_title IS NOT NULL
      BEGIN SELECT RAISE(ABORT, 'title write failed'); END;
    `);
    const id = "33333333-3333-4333-8333-333333333333";
    expect(() => writeSessionMetadata(db, id, parsedOpts([
      `--identity=${key}`, "--cluster=event-watch", "--role=event-worker", "--title=rollback",
    ]), NOW)).toThrow("title write failed");
    expect(getRow(db, id)).toBeNull();
    expect(getIdentity(db, key)).not.toBeNull();
  } finally {
    db.close();
  }
});

test("newSession: invalid role model and policy --via conflict fail before reservation", () => {
  const root = withEventRole();
  const roleToml = join(process.env.CCS_CONFIG_ROOT!, "clusters", "event-watch", "roles", "event-worker", "role.toml");
  writeFileSync(roleToml, 'kind = "session"\nwork_unit = "none"\nmodel = "gpt-5.6-terra[1m]"\n');
  expect(newSession(["--cluster=event-watch", "--role=event-worker", "--top-level", "--print-id"])).toBe(2);

  writeFileSync(roleToml, 'kind = "session"\nwork_unit = "none"\nmodel = "gpt-5.6-terra"\n');
  expect(newSession(["--cluster=event-watch", "--role=event-worker", "--top-level", "--via=claude", "--print-id"])).toBe(2);
  expect(newSession(["--cluster=event-watch", "--role=event-worker", "--top-level", "--model=gpt-5.6-sol", "--print-id"])).toBe(2);

  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally { check.close(); }
});

test("newSession: model-policy reservation records resolved launch provenance", () => {
  const root = withEventRole();
  const roleToml = join(process.env.CCS_CONFIG_ROOT!, "clusters", "event-watch", "roles", "event-worker", "role.toml");
  writeFileSync(roleToml, 'kind = "session"\nwork_unit = "none"\nmodel = "gpt-5.6-sol"\n');
  expect(newSession(["--cluster=event-watch", "--role=event-worker", "--top-level", "--print-id"])).toBe(0);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = check.query("SELECT session_id FROM catalogue").get() as { session_id: string };
    const stored = getRow(check, row.session_id)!;
    expect(getMeta(stored, "launch_model")).toBe("gpt-5.6-sol[1m]");
    expect(getMeta(stored, "launch_launcher")).toBe("claude-gpt");
  } finally { check.close(); }
});

test("newSession: explicit --print-id registers only a matching pre-minted identity", () => {
  const root = withEventRole();
  const key = "event-watch:event-worker:gio";
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
  } finally {
    db.close();
  }

  expect(newSession([
    `--identity=${key}`, "--cluster=event-watch", "--role=/event-worker", "--top-level", "--print-id",
  ])).toBe(0);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const rows = check.query("SELECT identity_key, resume_id, parent_session_id FROM catalogue").all() as Array<{
      identity_key: string; resume_id: string; parent_session_id: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.identity_key).toBe(key);
    expect(rows[0]?.resume_id).toBeDefined();
    expect(rows[0]?.parent_session_id).toBeNull();
    expect(check.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
  } finally {
    check.close();
  }
});

test("newSession: reserve-only automation anchor records stable provenance", () => {
  const root = withEventRole();
  process.env.CCS_CREATOR_KIND = "automation";
  process.env.CCS_CREATOR_REF = "imsg-server";

  expect(newSession(["--top-level", `--cwd=${root}`, "--title=iMessage automation", "--print-id"])).toBe(0);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = check.query(
      "SELECT session_class, parent_session_id, creator_kind, creator_ref, launch_channel FROM catalogue",
    ).get() as {
      session_class: string;
      parent_session_id: string | null;
      creator_kind: string;
      creator_ref: string;
      launch_channel: string;
    };
    expect(row).toEqual({
      session_class: "work_body",
      parent_session_id: null,
      creator_kind: "automation",
      creator_ref: "imsg-server",
      launch_channel: "ccs_session_new",
    });
  } finally {
    check.close();
  }
});

test("newSession: --location resolves and records a fresh top-level birth", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-location-birth-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  initGitRepo(cwd);
  mkdirSync(join(root, "cache"), { recursive: true });
  const registry = join(root, "locations.toml");
  writeFileSync(registry, `version = 1\ndefault_host = "Milads-M3-2"\n\n[[location]]\nkey = "ccs"\nname = "CCS"\ncwd = "${cwd}"\nkind = "repo"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-M3-2"\nstatus = "active"\n`);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n[routing]\nregistry = "${registry}"\n`);
  process.env.CCS_ROOT = root;

  expect(newSession(["--top-level", "--location=ccs", "--prompt=verify", "--print-id"])).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const rows = db.query("SELECT session_id FROM catalogue").all() as Array<{ session_id: string }>;
    expect(rows).toHaveLength(1);
    const row = getRow(db, rows[0]!.session_id)!;
    expect(row.customTitle).toBe("CCS");
    expect(row.sessionClass).toBe("work_body");
    expect(getMeta(row, "launch_location")).toBe("ccs");
  } finally {
    db.close();
  }
});

test("newSession: location route compiles exact model and launcher provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-location-route-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "cache"), { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude-gpt", model: "gpt-5.6-sol" });
  process.env.CCS_ROOT = root;

  expect(newSession(["--top-level", "--location=ccs", "--print-id"])).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = db.query("SELECT session_id FROM catalogue").get() as { session_id: string };
    const stored = getRow(db, row.session_id)!;
    expect(getMeta(stored, "launch_location_model")).toBe("gpt-5.6-sol");
    expect(getMeta(stored, "launch_model")).toBe("gpt-5.6-sol[1m]");
    expect(getMeta(stored, "launch_launcher")).toBe("claude-gpt");
  } finally {
    db.close();
  }
});

test("newSession: registry-wide route default compiles when a location has no override", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-registry-route-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  initGitRepo(cwd);
  mkdirSync(join(root, "cache"), { recursive: true });
  const registry = join(root, "locations.toml");
  writeFileSync(registry, `version = 1\ndefault_host = "Milads-M3-2"\ndefault_harness = "claude-gpt"\ndefault_model = "gpt-5.6-sol"\n\n[[location]]\nkey = "ccs"\nname = "CCS"\ncwd = "${cwd}"\nkind = "repo"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-M3-2"\nstatus = "active"\n`);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n[routing]\nregistry = "${registry}"\n`);
  process.env.CCS_ROOT = root;

  expect(newSession(["--top-level", "--location=ccs", "--print-id"])).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = db.query("SELECT session_id FROM catalogue").get() as { session_id: string };
    const stored = getRow(db, row.session_id)!;
    expect(getMeta(stored, "launch_location_model")).toBe("gpt-5.6-sol");
    expect(getMeta(stored, "launch_model")).toBe("gpt-5.6-sol[1m]");
    expect(getMeta(stored, "launch_launcher")).toBe("claude-gpt");
  } finally {
    db.close();
  }
});

test("newSession: invalid location route fails before reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-location-invalid-route-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "cache"), { recursive: true });
  process.env.CCS_ROOT = root;

  configureTestLocation(root, cwd, { harness: "claude", model: "gpt-5.6-sol" });
  expect(newSession(["--top-level", "--location=ccs", "--print-id"])).toBe(2);

  configureTestLocation(root, cwd, { harness: "claude", model: "claude-opus-4-8" });
  expect(newSession(["--top-level", "--location=ccs", "--print-id"])).toBe(2);

  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(db.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("newSession: explicit --via outranks an invalid location default route", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-location-explicit-via-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "cache"), { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude", model: "gpt-5.6-sol" });
  process.env.CCS_ROOT = root;

  expect(newSession(["--top-level", "--location=ccs", "--via=claude", "--print-id"])).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = db.query("SELECT session_id FROM catalogue").get() as { session_id: string };
    const stored = getRow(db, row.session_id)!;
    expect(getMeta(stored, "launch_location_model")).toBe("gpt-5.6-sol");
    expect(getMeta(stored, "launch_model")).toBeUndefined();
    expect(getMeta(stored, "launch_launcher")).toBeUndefined();
  } finally {
    db.close();
  }
});

test("newSession: explicit canonical model outranks an invalid location default", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-location-explicit-model-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "cache"), { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude", model: "claude-opus-4-8" });
  process.env.CCS_ROOT = root;

  expect(newSession(["--top-level", "--location=ccs", "--model=gpt-5.6-terra", "--print-id"])).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = db.query("SELECT session_id FROM catalogue").get() as { session_id: string };
    const stored = getRow(db, row.session_id)!;
    expect(getMeta(stored, "launch_location_model")).toBe("claude-opus-4-8");
    expect(getMeta(stored, "launch_model")).toBe("gpt-5.6-terra[1m]");
    expect(getMeta(stored, "launch_launcher")).toBe("claude-gpt");
  } finally {
    db.close();
  }
});

test("newSession: invalid or contradictory explicit model flags fail before reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-explicit-model-invalid-"));
  roots.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  process.env.CCS_ROOT = root;
  expect(newSession(["--top-level", `--cwd=${root}`, "--model=opus", "--print-id"])).toBe(2);
  expect(newSession(["--top-level", `--cwd=${root}`, "--model=gpt-5.6-terra", "--via=claude-gpt", "--print-id"])).toBe(2);
  expect(newSession(["--top-level", `--cwd=${root}`, "--require-capability", "--model", "gpt-5.6-sol", "--print-id"])).toBe(2);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(db.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("newSession: required local host capabilities are checked before reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-local-capabilities-"));
  roots.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  configureLocalTestHost(root);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "milads-m3-2"\n[routing]\nhosts = "${join(root, "hosts.toml")}"\n`);
  process.env.CCS_ROOT = root;

  expect(newSession([
    "--top-level",
    `--cwd=${root}`,
    "--model=gpt-5.6-sol",
    "--require-capability=always-on",
    "--print-id",
  ])).toBe(2);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(db.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});

test("newSession: required local host capabilities match case-insensitively", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-local-capability-match-"));
  roots.push(root);
  mkdirSync(join(root, "cache"), { recursive: true });
  configureLocalTestHost(root);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "milads-m3-2"\n[routing]\nhosts = "${join(root, "hosts.toml")}"\n`);
  process.env.CCS_ROOT = root;

  expect(newSession([
    "--top-level",
    `--cwd=${root}`,
    "--model=gpt-5.6-sol",
    "--require-capability=SHARED-VAULT",
    "--print-id",
  ])).toBe(0);
});

test("newSession: role model policy outranks location defaults while preserving location cwd", () => {
  const root = withEventRole();
  const roleToml = join(process.env.CCS_CONFIG_ROOT!, "clusters", "event-watch", "roles", "event-worker", "role.toml");
  writeFileSync(roleToml, 'kind = "session"\nwork_unit = "none"\nmodel = "gpt-5.6-terra"\n');
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude-gpt", model: "gpt-5.6-sol" });

  expect(newSession(["--cluster=event-watch", "--role=event-worker", "--top-level", "--location=ccs", "--print-id"])).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const row = db.query("SELECT session_id FROM catalogue").get() as { session_id: string };
    const stored = getRow(db, row.session_id)!;
    expect(stored.customTitle).toBe("CCS");
    expect(getMeta(stored, "launch_location_model")).toBe("gpt-5.6-sol");
    expect(getMeta(stored, "launch_model")).toBe("gpt-5.6-terra[1m]");
    expect(getMeta(stored, "launch_launcher")).toBe("claude-gpt");
  } finally {
    db.close();
  }
});

test("newSession: remote host uses preflight and one cmux transport without local reservation", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-remote-host-"));
  roots.push(root);
  const cwd = join(root, "remote-project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude-gpt", model: "gpt-5.6-sol" }, "Milads-Mac-mini");
  configureTestHosts(root);
  process.env.CCS_ROOT = root;
  process.env.CCS_CREATOR_KIND = "agent";
  process.env.CCS_CREATOR_REF = "11111111-1111-4111-8111-111111111111";

  const preflightRequests: Array<Parameters<RemoteSessionDependencies["preflight"]>[0]> = [];
  const launchRequests: Array<Parameters<RemoteSessionDependencies["launch"]>[0]> = [];
  const dependencies: RemoteSessionDependencies = {
    preflight(request) {
      preflightRequests.push(request);
      return { ok: true, value: {
        targetHost: request.targetHost,
        locationKey: request.locationKey,
        locationName: "CCS",
        cwd: "/remote/ccs",
      } };
    },
    launch(request) {
      launchRequests.push(request);
      return { ok: true, receipt: {
        status: "workspace_created",
        session_id: "pending",
        host: request.targetHost,
        location: request.locationKey,
        cwd: request.remoteCwd,
        workspace_ref: "workspace:501",
        uncertainty: "receipt pending",
      } };
    },
  };

  expect(newSession([
    "--top-level",
    "--host=Milads-Mac-mini",
    "--location=ccs",
    "--require-capability=always-on",
    "--require-capability=shared-vault",
    "--prompt=--inspect remote routing",
  ], dependencies)).toBe(0);
  expect(preflightRequests).toEqual([{
    targetHost: "Milads-Mac-mini",
    sshAlias: "macmini",
    locationKey: "ccs",
    route: {
      launcher: "claude-gpt",
      model: "gpt-5.6-sol",
      launchModel: "gpt-5.6-sol[1m]",
    },
    via: undefined,
    model: "gpt-5.6-sol",
    requiredCapabilities: ["always-on", "shared-vault"],
  }]);
  expect(launchRequests[0]).toMatchObject({
    targetHost: "Milads-Mac-mini",
    sshAlias: "macmini",
    locationKey: "ccs",
    prompt: "--inspect remote routing",
    model: "gpt-5.6-sol",
    requiredCapabilities: ["always-on", "shared-vault"],
    creatorKind: "agent",
    creatorRef: "11111111-1111-4111-8111-111111111111",
    remoteCwd: "/remote/ccs",
  });
  expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
});

test("newSession: remote explicit routes outrank an invalid location default", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-remote-explicit-route-"));
  roots.push(root);
  const cwd = join(root, "remote-project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude", model: "gpt-5.6-sol" }, "Milads-Mac-mini");
  configureTestHosts(root);
  process.env.CCS_ROOT = root;

  const preflights: Array<Parameters<RemoteSessionDependencies["preflight"]>[0]> = [];
  const launches: Array<Parameters<RemoteSessionDependencies["launch"]>[0]> = [];
  const dependencies: RemoteSessionDependencies = {
    preflight(request) {
      preflights.push(request);
      return { ok: true, value: {
        targetHost: request.targetHost,
        locationKey: request.locationKey,
        locationName: "CCS",
        cwd: "/remote/ccs",
      } };
    },
    launch(request) {
      launches.push(request);
      return { ok: true, receipt: {
        status: "workspace_created",
        session_id: "pending",
        host: request.targetHost,
        location: request.locationKey,
        cwd: request.remoteCwd,
        workspace_ref: `workspace:${launches.length}`,
        uncertainty: "receipt pending",
      } };
    },
  };

  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--model=claude-fable-5",
  ], dependencies)).toBe(0);
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--via=claude",
  ], dependencies)).toBe(0);
  expect(preflights).toHaveLength(2);
  expect(preflights[0]).toMatchObject({
    route: { launcher: "claude", model: "claude-fable-5", launchModel: "claude-fable-5" },
    model: "claude-fable-5",
    via: undefined,
  });
  expect(preflights[1]).toMatchObject({
    route: { launcher: "claude", model: null, launchModel: null },
    model: null,
    via: "claude",
  });
  expect(launches).toHaveLength(2);
  expect(launches[0]).toMatchObject({ model: "claude-fable-5", via: undefined });
  expect(launches[1]).toMatchObject({ model: undefined, via: "claude" });
  expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
});

test("newSession: remote route and capability failures stop before preflight or workspace creation", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-remote-source-validation-"));
  roots.push(root);
  const cwd = join(root, "remote-project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, { harness: "claude-gpt", model: "gpt-5.6-sol" }, "Milads-Mac-mini");
  configureTestHosts(root);
  process.env.CCS_ROOT = root;
  const unused: RemoteSessionDependencies = {
    preflight() { throw new Error("source validation must run before SSH preflight"); },
    launch() { throw new Error("source validation must run before cmux workspace creation"); },
  };

  expect(newSession([
    "--top-level",
    "--host=Milads-Mac-mini",
    "--location=ccs",
    "--require-capability=interactive-gui",
  ], unused)).toBe(2);
  expect(newSession([
    "--top-level",
    "--host=Milads-Mac-mini",
    "--location=ccs",
    "--model=not-a-model",
  ], unused)).toBe(2);
  expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
});

test("session preflight resolves launchers, models, and capabilities with target-side authorities only", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-target-preflight-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, null, "Milads-Mac-mini");
  configureTestHosts(root);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-Mac-mini"\n[routing]\nregistry = "${join(root, "locations.toml")}"\nhosts = "${join(root, "hosts.toml")}"\n\n[[launcher]]\nname = "target-gpt"\nbinary = "claude-gpt"\nserves = ["*"]\n`);
  process.env.CCS_ROOT = root;

  const success = captureJsonReceipt(() => preflightNewSession([
    "--top-level",
    "--host=Milads-Mac-mini",
    "--location=ccs",
    "--via=target-gpt",
    "--require-capability=always-on",
  ]));
  expect(success.exitCode).toBe(0);
  expect(success.receipt).toMatchObject({
    status: "ready",
    host: "Milads-Mac-mini",
    route: { launcher: "target-gpt", model: null, launchModel: null },
    required_capabilities: ["always-on"],
  });

  expect(preflightNewSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--via=old-gateway",
  ])).toBe(2);
  expect(preflightNewSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--model=gpt-5.7-sol",
  ])).toBe(2);
  expect(preflightNewSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--require-capability=browser-auth",
  ])).toBe(2);
  expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
});

test("newSession: target route preflight failures create no remote workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-remote-preflight-failure-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, null, "Milads-Mac-mini");
  configureTestHosts(root);
  process.env.CCS_ROOT = root;

  let preflightCalls = 0;
  let workspaceCreations = 0;
  const blockers = [
    new Error('unknown launcher "old-gateway"'),
    new Error('unsupported --model "gpt-5.6-sol" on target'),
    new Error('host "Milads-Mac-mini" lacks required capability "shared-vault"'),
  ];
  const dependencies: RemoteSessionDependencies = {
    preflight() {
      const error = blockers[preflightCalls++];
      if (!error) throw new Error("unexpected preflight call");
      return { ok: false, error };
    },
    launch() {
      workspaceCreations++;
      throw new Error("workspace creation must not run after failed preflight");
    },
  };

  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--via=old-gateway",
  ], dependencies)).toBe(2);
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--model=gpt-5.6-sol",
  ], dependencies)).toBe(2);
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--require-capability=shared-vault",
  ], dependencies)).toBe(2);
  expect(preflightCalls).toBe(3);
  expect(workspaceCreations).toBe(0);
  expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
});

test("newSession: current --host preserves the established local path", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-current-host-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "cache"), { recursive: true });
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n`);
  process.env.CCS_ROOT = root;
  const unused: RemoteSessionDependencies = {
    preflight() { throw new Error("current host must not preflight SSH"); },
    launch() { throw new Error("current host must not launch cmux SSH"); },
  };

  expect(newSession([
    "--top-level",
    "--host=Milads-M3-2",
    `--cwd=${cwd}`,
    "--print-id",
  ], unused)).toBe(0);
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(db.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 1 });
  } finally {
    db.close();
  }
});

test("newSession: remote host must be known, active, and location-eligible", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-invalid-remote-host-"));
  roots.push(root);
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  configureTestLocation(root, cwd, null, "Milads-Mac-mini");
  configureTestHosts(root, "retired");
  process.env.CCS_ROOT = root;
  const unused: RemoteSessionDependencies = {
    preflight() { throw new Error("invalid host must not preflight SSH"); },
    launch() { throw new Error("invalid host must not launch cmux SSH"); },
  };

  expect(newSession([
    "--top-level", "--host=Unknown", "--location=ccs",
  ], unused)).toBe(2);
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs",
  ], unused)).toBe(2);

  configureTestHosts(root, "active");
  configureTestLocation(root, cwd, null, "Milads-M3-2");
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs",
  ], unused)).toBe(2);
  expect(existsSync(join(root, "cache", "catalogue.db"))).toBe(false);
});

test("newSession: remote placement rejects unsupported receipt and surface modes", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-ns-remote-options-"));
  roots.push(root);
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n`);
  process.env.CCS_ROOT = root;
  const unused: RemoteSessionDependencies = {
    preflight() { throw new Error("invalid remote options must not preflight SSH"); },
    launch() { throw new Error("invalid remote options must not launch cmux SSH"); },
  };

  expect(newSession([
    "--top-level", "--host=", "--location=ccs",
  ], unused)).toBe(2);
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--print-id",
  ], unused)).toBe(2);
  expect(newSession([
    "--top-level", "--host=Milads-Mac-mini", "--location=ccs", "--inline",
  ], unused)).toBe(2);
});

test("newSession: automation declaration without a stable ref fails before registration", () => {
  const root = withEventRole();
  process.env.CCS_CREATOR_KIND = "automation";
  delete process.env.CCS_CREATOR_REF;
  expect(newSession(["--top-level", `--cwd=${root}`, "--print-id"])).toBe(2);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally {
    check.close();
  }
});

test("newSession: --top-level rejects --parent for legacy births before registration", () => {
  const root = withEventRole();
  expect(newSession([
    "--cluster=event-watch", "--role=event-worker", "--top-level", "--parent=parent-session", "--print-id",
  ])).toBe(2);
  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
  } finally {
    check.close();
  }
});

test("newSession: explicit birth rejects absent identity, missing or mismatched axes, and --key before registration", () => {
  const root = withEventRole();
  const key = "event-watch:event-worker:gio";
  const db = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    const { mintIdentity } = require("../catalogue/identities.ts") as typeof import("../catalogue/identities.ts");
    mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
  } finally {
    db.close();
  }

  expect(newSession(["--identity=event-watch:event-worker:missing", "--cluster=event-watch", "--role=event-worker", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--role=event-worker", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--cluster=other-cluster", "--role=event-worker", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--cluster=event-watch", "--role=other-role", "--print-id"])).toBe(2);
  expect(newSession([`--identity=${key}`, "--cluster=event-watch", "--role=event-worker", "--key=legacy", "--print-id"])).toBe(2);
  expect(newSession([
    `--identity=${key}`, "--cluster=event-watch", "--role=event-worker",
    "--pr-repo=owner/repo", "--pr-number=123", "--print-id",
  ])).toBe(2);

  const check = openCatalogue(join(root, "cache", "catalogue.db"));
  try {
    expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
    expect(check.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
  } finally {
    check.close();
  }
});

test("writeSessionMetadata: binds identity to a not-yet-indexed id (forward reference)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    writeSessionMetadata(db, id, parsedOpts([
      "--cluster", "pr-watch",
      "--role", "pr-agent",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
      "--title", "#12080 Fix navbar",
    ]), NOW);

    const row = getRow(db, id);
    expect(row).not.toBeNull();
    expect(row!.cluster).toBe("pr-watch");
    expect(row!.role).toBe("pr-agent");
    expect(row!.kind).toBe("session");
    // ADR-0089: identity_key is the structured <cluster>:<role>:<work_ref> form.
    expect(row!.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#12080");
    expect(row!.customTitle).toBe("#12080 Fix navbar");
    expect(row!.resumeId).toBe(id);
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: a leading slash on the role is normalised away", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeSessionMetadata(db, id, parsedOpts(["--cluster", "pr-watch", "--role", "/pr-watch-control"]), NOW);
    expect(getRow(db, id)!.role).toBe("pr-watch-control");
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: stamps gus-work + PR facts at birth (statusline link from turn one)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "cccccccc-dddd-eeee-ffff-000000000000";
    writeSessionMetadata(db, id, parsedOpts([
      "--cluster", "pr-watch", "--role", "pr-agent",
      "--gus-work", "W-23034218",
      "--pr-number", "12080", "--pr-repo", "heroku/dashboard",
    ]), NOW);
    const row = getRow(db, id)!;
    // ADR-0089: per-role table isn't materialized in :memory: without a config root, so
    // per-role attrs read as null here. The identity mint succeeded; the join is empty.
    // Assert the identity_key was built from PR facts.
    expect(row.identityKey).toBe("pr-watch:pr-agent:heroku/dashboard#12080");
  } finally {
    db.close();
  }
});

test("parseOpts: --pr-number 0 (no PR yet) is treated as absent, not stamped", () => {
  const o = parsedOpts(["--pr-number", "0", "--pr-repo", "heroku/dashboard"]);
  expect(o.prNumber).toBeUndefined();
});

test("writeSessionMetadata: --resume-command is not persisted outside the role definition", () => {
  withPrRole();
  const db = openCatalogue(":memory:");
  try {
    const id = "ffffffff-0000-1111-2222-333333333333";
    const opts = parsedOpts([
      "--cluster", "pr-watch",
      "--role", "pr-agent",
      "--pr-number", "12080",
      "--pr-repo", "heroku/dashboard",
      "--resume-command", "/loop 15m /pr-watch-control",
    ]);
    expect(opts.resumeCommand).toBeUndefined();
    writeSessionMetadata(db, id, opts, NOW);
    expect(getRow(db, id)!.resumeCommand).toBeNull();
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: only the provided fields are written (no clobber to defaults)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "99999999-8888-7777-6666-555555555555";
    // ADR-0089 v33: cluster only surfaces through the identity join, so pass role too.
    writeSessionMetadata(db, id, parsedOpts(["--cluster", "pr-watch", "--role", "concierge"]), NOW);
    const row = getRow(db, id)!;
    expect(row.cluster).toBe("pr-watch");
    expect(row.role).toBe("concierge");
    expect(row.customTitle).toBeNull();
    expect(lifecycleOf(row)).toBe("idle");
  } finally {
    db.close();
  }
});

import { validateSpawn } from "./new-session.ts";
import type { RoleDef } from "../catalogue/db.ts";

const loopDef: RoleDef = {
  role: "control", cluster: "pr-watch", kind: "loop", workUnit: "none", homeDir: "/tmp",
  resumeCommand: "/loop 15m /pr-watch-control", stageSchema: null, pinOnResume: false, color: null, model: null, permissionMode: null, manifestError: null, skills: [], commands: [], hooks: [], updatedAt: null,
};

test("writeSessionMetadata: --role without --cluster inherits cluster from role registry + mints identity", () => {
  // Punch-list guarantee: spawning with only --role (a common ergonomic
  // shortcut for cluster-scoped roles) infers --cluster from the role's
  // registered cluster path and mints the identity_key. Regression against
  // the 'silently skips identity minting when cluster is unset' hazard.
  withPrRole();
  // Register a core (no work_unit) role under pr-watch/roles/concierge so we
  // exercise the core path — the pr-agent path already needs pr flags.
  const cfg = process.env.CCS_CONFIG_ROOT!;
  const conciergeDir = join(cfg, "clusters", "pr-watch", "roles", "concierge");
  mkdirSync(conciergeDir, { recursive: true });
  writeFileSync(join(conciergeDir, "role.toml"), 'kind = "session"\nwork_unit = "none"\n');

  const db = openCatalogue(":memory:");
  try {
    const sid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    // --role only, NO --cluster; resolveRole should return the pr-watch role
    // and callers upstream default opts.cluster from roleDef.cluster before
    // reaching writeSessionMetadata. Simulate that fill-in here (since this
    // test drives writeSessionMetadata directly).
    const opts = parsedOpts(["--role", "concierge"]);
    opts.cluster = "pr-watch"; // <-- what newSession() does before writeSessionMetadata
    writeSessionMetadata(db, sid, opts, NOW);
    const row = getRow(db, sid)!;
    expect(row.identityKey).toBe("pr-watch:concierge");
  } finally {
    db.close();
  }
});

test("buildLaunchArgv: model option precedes session ID and policy-less argv is unchanged", () => {
  expect(buildLaunchArgv("id", { printId: false, inline: false, launchModel: "gpt-5.6-terra[1m]" }, "claude-gpt"))
    .toEqual(["claude-gpt", "--model", "gpt-5.6-terra[1m]", "--session-id", "id"]);
  expect(buildLaunchArgv("id", { printId: false, inline: false })).toEqual(["claude", "--session-id", "id"]);
});

test("validateSpawn: unknown role errors", () => {
  expect(validateSpawn(parsedOpts(["--role", "ghost"]), null)).toContain("not in the registry");
});

test("validateSpawn: loop role without resume_command errors (would launch dormant)", () => {
  const def: RoleDef = { ...loopDef, resumeCommand: null };
  expect(validateSpawn({ printId: false, inline: false }, def)).toContain("no resume_command");
});

test("validateSpawn: missing cwd errors", () => {
  expect(validateSpawn({ printId: false, inline: false, cwd: "/no/such/dir/xyz" }, null)).toContain("cwd does not exist");
});

test("validateSpawn: a well-formed loop role passes", () => {
  expect(validateSpawn({ printId: false, inline: false, role: "control", cwd: "/tmp", resumeCommand: "/loop 15m /x" }, loopDef)).toBeNull();
});

test("validateSpawn: standalone role (no cluster in role def, no --cluster arg) is rejected (ADR-0089 identity support)", () => {
  // Standalone roles are not supported: they would create sessions with NULL identity_key.
  // Rejection prevents latent data-integrity issues.
  const standaloneRoleDef: RoleDef = {
    role: "debug", kind: "session", cluster: null, workUnit: null, homeDir: "/tmp",
    resumeCommand: null, stageSchema: null, pinOnResume: false, color: null, model: null, permissionMode: null, manifestError: null, skills: [], commands: [], hooks: [], updatedAt: null,
  };
  const err = validateSpawn({ printId: false, inline: false, role: "debug" }, standaloneRoleDef);
  expect(err).toContain("standalone role");
  expect(err).toContain("not supported");
});
