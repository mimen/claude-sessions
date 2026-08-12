import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitContextForPath, locationCommand } from "./command.ts";
import { openCatalogue } from "../catalogue/db-schema.ts";
import { setSaved, setSessionClass } from "../catalogue/db-mutations.ts";
import { openIndex } from "../index/schema.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.CCS_ROOT;
});

function setup(): { root: string; registry: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "ccs-location-command-"));
  roots.push(root);
  const project = join(root, "project");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  execFileSync("git", ["-C", project, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", project, "config", "user.name", "Test"]);
  writeFileSync(join(project, "README.md"), "project\n");
  execFileSync("git", ["-C", project, "add", "README.md"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "initial"]);
  const registry = join(root, "locations.toml");
  writeFileSync(registry, `version = 1
default_host = "Milads-M3-2"
default_harness = "claude-gpt"
default_model = "gpt-5.6-sol"

[[location]]
key = "ccs"
name = "CCS"
aliases = ["session catalogue"]
cwd = "${project}"
kind = "repo"
eligible_hosts = ["Milads-M3-2"]
preferred_host = "Milads-M3-2"
status = "active"
`);
  const hosts = join(root, "hosts.toml");
  writeFileSync(hosts, `version = 1

[[host]]
name = "Milads-M3-2"
ssh_alias = "milads-m3"
capabilities = ["interactive-gui", "local-user-state"]
status = "active"

[[host]]
name = "Milads-Mac-mini"
ssh_alias = "macmini"
capabilities = ["always-on", "headless", "ssh"]
status = "active"
`);
  mkdirSync(join(root, "cache"));
  writeFileSync(join(root, "config.toml"), `[host]\nlabel = "Milads-M3-2"\n[routing]\nregistry = "${registry}"\nhosts = "${hosts}"\n`);
  process.env.CCS_ROOT = root;
  return { root, registry, project };
}

function captureLogs(run: () => number): { rc: number; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...values: object[]) => logs.push(values.join(" ")));
  const error = spyOn(console, "error").mockImplementation((...values: object[]) => errors.push(values.join(" ")));
  try {
    return { rc: run(), logs, errors };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

test("git context distinguishes the main checkout from a linked dirty worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-location-git-"));
  roots.push(root);
  const repo = join(root, "repo");
  const linked = join(root, "linked");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "main\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "feature/test", linked]);
  writeFileSync(join(linked, "dirty.txt"), "dirty\n");

  const main = gitContextForPath(repo);
  const worktree = gitContextForPath(linked);
  expect(main?.linkedWorktree).toBe(false);
  expect(main?.dirty).toBe(false);
  expect(worktree?.linkedWorktree).toBe(true);
  expect(worktree?.branch).toBe("feature/test");
  expect(worktree?.dirty).toBe(true);
  expect(worktree?.commonDir).toBe(main?.commonDir);
});

test("list and show read the configured registry", () => {
  const { project } = setup();
  const listed = captureLogs(() => locationCommand(["ls", "--json"]));
  expect(listed.rc).toBe(0);
  expect(JSON.parse(listed.logs.join("\n")).locations[0].key).toBe("ccs");

  const shown = captureLogs(() => locationCommand(["show", "ccs", "--json"]));
  expect(shown.rc).toBe(0);
  const payload = JSON.parse(shown.logs.join("\n"));
  expect(payload.host_eligible).toBe(true);
  expect(payload.current_host).toBe("Milads-M3-2");
  expect(payload.host_capabilities).toEqual(["interactive-gui", "local-user-state"]);
  expect(payload.default_harness).toBe("claude-gpt");
  expect(payload.default_model).toBe("gpt-5.6-sol");
  expect(payload.declared_default_model).toBeNull();
  expect(payload.git_state.root).toBe(realpathSync(project));
  expect(payload.registered_hosts).toHaveLength(2);
  expect(payload.caller_context.cwd).toBeTruthy();
});

test("match is fresh-only and returns deterministic candidates", () => {
  setup();
  const matched = captureLogs(() => locationCommand(["match", "work", "on", "the", "session", "catalogue", "--json"]));
  expect(matched.rc).toBe(0);
  const payload = JSON.parse(matched.logs.join("\n"));
  expect(payload.fresh_only).toBe(true);
  expect(payload.default_harness).toBe("claude-gpt");
  expect(payload.default_model).toBe("gpt-5.6-sol");
  expect(payload.candidates[0].key).toBe("ccs");
  expect(payload.candidates[0].score).toBeGreaterThan(0.9);
  expect(payload.candidates[0].default_model).toBe("gpt-5.6-sol");
  expect(payload.candidates[0].host_capabilities).toContain("interactive-gui");
  expect(payload.registered_hosts.find((host: { name: string }) => host.name === "Milads-Mac-mini").capabilities)
    .toContain("always-on");
  expect(payload.caller_context).toHaveProperty("cwd");
});

test("match does not warn about Saved sessions at a location", () => {
  const { root, project } = setup();
  const index = openIndex(join(root, "cache", "index.db"));
  index.query(`INSERT INTO sessions(session_id,host,path,cwd,project_root,project_name,fallback_label,msg_count,file_mtime,file_size,skeleton,resume_id,cost_usd,tok_input,tok_output,tok_cache_read,tok_cache_write,is_subagent) VALUES ('saved','h','/saved',$cwd,$cwd,'work','Saved work',1,1,1,'','saved',0,0,0,0,0,0)`).run({ $cwd: project });
  index.close();
  const catalogue = openCatalogue(join(root, "cache", "catalogue.db"), { materialize: false });
  setSessionClass(catalogue, "saved", "work_body", "2026-08-11T00:00:00Z");
  setSaved(catalogue, "saved", true, "2026-08-11T00:00:00Z");
  catalogue.close();

  const matched = captureLogs(() => locationCommand(["match", "session", "catalogue", "--json"]));
  expect(JSON.parse(matched.logs.join("\n")).candidates[0].existing_session_warnings).toEqual([]);
});

test("match exposes registry defaults even when no location matches", () => {
  setup();
  const matched = captureLogs(() => locationCommand(["match", "zzzz-no-registered-location", "--json"]));
  expect(matched.rc).toBe(3);
  const payload = JSON.parse(matched.logs.join("\n"));
  expect(payload.candidates).toEqual([]);
  expect(payload.default_harness).toBe("claude-gpt");
  expect(payload.default_model).toBe("gpt-5.6-sol");
});

test("corrupt session databases do not block deterministic route matching", () => {
  const { root } = setup();
  writeFileSync(join(root, "cache", "index.db"), "not sqlite");
  writeFileSync(join(root, "cache", "catalogue.db"), "not sqlite");
  const matched = captureLogs(() => locationCommand(["match", "session", "catalogue", "--json"]));
  expect(matched.rc).toBe(0);
  const payload = JSON.parse(matched.logs.join("\n"));
  expect(payload.candidates[0].key).toBe("ccs");
  expect(payload.candidates[0].existing_session_warnings).toEqual([]);
});

test("register writes only an explicitly supplied durable cwd", () => {
  const { root, registry } = setup();
  const second = join(root, "second");
  mkdirSync(second);
  execFileSync("git", ["init", "-q", second], { stdio: "ignore" });

  const temporary = captureLogs(() => locationCommand([
    "register", "second", "--cwd", second, "--name", "Second", "--kind", "repo",
  ]));
  expect(temporary.rc).toBe(2);
  expect(temporary.errors.join("\n")).toContain("is temporary");
  expect(readFileSync(registry, "utf8")).not.toContain('key = "second"');

  const registered = captureLogs(() => locationCommand([
    "register", "second", "--cwd", second, "--name", "Second", "--alias", "other project", "--kind", "repo",
  ], { registrationPathPolicy: { temporaryRoots: [] } }));
  expect(registered.rc).toBe(0);
  expect(readFileSync(registry, "utf8")).toContain('key = "second"');

  const missing = captureLogs(() => locationCommand(["register", "missing", "--cwd", join(root, "absent")]));
  expect(missing.rc).toBe(2);
  expect(missing.errors.join("\n")).toContain("does not exist");

  const invalidRoute = join(root, "invalid-route");
  mkdirSync(invalidRoute);
  execFileSync("git", ["init", "-q", invalidRoute], { stdio: "ignore" });
  const invalid = captureLogs(() => locationCommand([
    "register", "invalid-route", "--cwd", invalidRoute,
    "--default-harness", "claude", "--default-model", "bogus",
  ]));
  expect(invalid.rc).toBe(2);
  expect(readFileSync(registry, "utf8")).not.toContain('key = "invalid-route"');
});

test("retire preserves the entry but removes it from default list", () => {
  setup();
  expect(captureLogs(() => locationCommand(["retire", "ccs"])).rc).toBe(0);
  const listed = captureLogs(() => locationCommand(["list", "--json"]));
  expect(JSON.parse(listed.logs.join("\n")).locations).toHaveLength(0);
  const all = captureLogs(() => locationCommand(["list", "--json", "--all"]));
  expect(JSON.parse(all.logs.join("\n")).locations[0].status).toBe("retired");
});
