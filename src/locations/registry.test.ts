import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveLocationDefaults,
  loadLocationRegistry,
  matchLocations,
  registerLocation,
  resolveLocationForHost,
  retireLocation,
  type LaunchLocation,
} from "./registry.ts";

const roots: string[] = [];
const LAPTOP_HOST = "Milads-M3-2";
const MINI_HOST = "Milads-Mac-mini";
const TEST_REGISTRATION_POLICY = { temporaryRoots: [] } as const;

const locationHeader = `version = 1
default_host = "${LAPTOP_HOST}"
`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ccs-locations-"));
  roots.push(root);
  return root;
}

function writeRegistry(root: string, body: string): string {
  const path = join(root, "locations.toml");
  writeFileSync(path, body);
  return path;
}

function initRepo(path: string): void {
  execFileSync("git", ["init", "-q", path], { stdio: "ignore" });
}

test("loads the vault registry shape and canonical host defaults", () => {
  const fixture = join(import.meta.dir, "fixtures", "vault-locations.toml");
  const loaded = loadLocationRegistry(fixture);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  expect(loaded.value.defaultHost).toBe(MINI_HOST);
  expect(loaded.value.defaultHarness).toBe("claude-gpt");
  expect(loaded.value.defaultModel).toBe("gpt-5.6-sol");
  expect(loaded.value.locations).toHaveLength(30);
  expect(new Set(loaded.value.locations.map((location) => location.kind))).toEqual(
    new Set(["root", "workspace", "repo", "config"]),
  );
  const home = loaded.value.locations.find((location) => location.key === "home");
  expect(effectiveLocationDefaults(loaded.value, home!)).toEqual({
    defaultHarness: "claude-gpt",
    defaultModel: "gpt-5.6-sol",
  });
  const ccs = loaded.value.locations.find((location) => location.key === "ccs");
  expect(ccs?.preferredHost).toBe(MINI_HOST);
  expect(ccs?.defaultHarness).toBe("claude-gpt");
  expect(ccs?.defaultModel).toBe("gpt-5.6-sol");
  expect(resolveLocationForHost(ccs!, LAPTOP_HOST).ok).toBe(true);
  expect(resolveLocationForHost(ccs!, MINI_HOST).ok).toBe(true);
});

test("loads a typed registry and expands a location cwd when resolving", () => {
  const root = tempRoot();
  const cwd = join(root, "ccs");
  mkdirSync(cwd);
  initRepo(cwd);
  const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "ccs"
name = "CCS"
aliases = ["claude sessions", "session catalogue"]
cwd = "${cwd}"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}", "${MINI_HOST}"]
preferred_host = "${MINI_HOST}"
default_harness = "claude-gpt"
default_model = "gpt-5.6-sol"
status = "active"
`);

  const loaded = loadLocationRegistry(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.defaultHost).toBe(LAPTOP_HOST);
  expect(loaded.value.locations).toHaveLength(1);
  expect(loaded.value.locations[0]?.key).toBe("ccs");

  const resolved = resolveLocationForHost(loaded.value.locations[0]!, LAPTOP_HOST);
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value.cwd).toBe(realpathSync(cwd));
  expect(resolved.value.defaultHarness).toBe("claude-gpt");
});

test("requires the exact root schema", () => {
  const root = tempRoot();
  const missingDefault = writeRegistry(root, "version = 1\n");
  const missing = loadLocationRegistry(missingDefault);
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.message).toContain("default_host");

  const unsupportedVersion = writeRegistry(root, `version = 2\ndefault_host = "${MINI_HOST}"\n`);
  const unsupported = loadLocationRegistry(unsupportedVersion);
  expect(unsupported.ok).toBe(false);
  if (!unsupported.ok) expect(unsupported.error.message).toContain("version");
});

test("rejects duplicate selectors across active locations", () => {
  const root = tempRoot();
  const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "one"
name = "One"
aliases = ["shared"]
cwd = "/tmp/one"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"

[[location]]
key = "two"
name = "Two"
aliases = ["shared"]
cwd = "/tmp/two"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"
`);

  const loaded = loadLocationRegistry(path);
  expect(loaded.ok).toBe(false);
  if (loaded.ok) return;
  expect(loaded.error.message).toContain('alias "shared"');
});

test("allows retired selectors to be reused by active locations", () => {
  const root = tempRoot();
  const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "old"
name = "Old"
aliases = ["shared"]
cwd = "/tmp/old"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "retired"

[[location]]
key = "new"
name = "New"
aliases = ["shared"]
cwd = "/tmp/new"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"
`);

  expect(loadLocationRegistry(path).ok).toBe(true);
});

test("rejects unsupported kinds, relative paths, invalid preferred hosts, and unpaired defaults", () => {
  const root = tempRoot();
  const cases = [
    {
      name: "unsupported kind",
      field: 'cwd = "/tmp/project"\nkind = "directory"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-M3-2"',
      message: "kind",
    },
    {
      name: "relative cwd",
      field: 'cwd = "relative/project"\nkind = "repo"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-M3-2"',
      message: "cwd must be absolute",
    },
    {
      name: "invalid preferred host",
      field: 'cwd = "/tmp/project"\nkind = "repo"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-Mac-mini"',
      message: "must be a member",
    },
    {
      name: "unpaired defaults",
      field: 'cwd = "/tmp/project"\nkind = "repo"\neligible_hosts = ["Milads-M3-2"]\npreferred_host = "Milads-M3-2"\ndefault_harness = "claude-gpt"',
      message: "must declare default_harness and default_model together",
    },
  ] as const;

  for (const testCase of cases) {
    const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "project-${testCase.name.replaceAll(" ", "-")}"
name = "Project"
aliases = []
${testCase.field}
status = "active"
`);
    const loaded = loadLocationRegistry(path);
    expect(loaded.ok, testCase.name).toBe(false);
    if (!loaded.ok) expect(loaded.error.message).toContain(testCase.message);
  }
});

test("root model defaults are paired and inherited unless a location overrides them", () => {
  const root = tempRoot();
  const path = writeRegistry(root, `${locationHeader}default_harness = "claude-gpt"
default_model = "gpt-5.6-sol"

[[location]]
key = "inherited"
name = "Inherited"
cwd = "/tmp/inherited"
kind = "workspace"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"

[[location]]
key = "override"
name = "Override"
cwd = "/tmp/override"
kind = "workspace"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
default_harness = "claude"
default_model = "claude-fable-5"
status = "active"
`);
  const loaded = loadLocationRegistry(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.defaultHarness).toBe("claude-gpt");
  expect(loaded.value.defaultModel).toBe("gpt-5.6-sol");
  expect(effectiveLocationDefaults(loaded.value, loaded.value.locations[0]!)).toEqual({
    defaultHarness: "claude-gpt",
    defaultModel: "gpt-5.6-sol",
  });
  expect(effectiveLocationDefaults(loaded.value, loaded.value.locations[1]!)).toEqual({
    defaultHarness: "claude",
    defaultModel: "claude-fable-5",
  });

  const invalid = writeRegistry(root, `${locationHeader}default_harness = "claude-gpt"\n`);
  const result = loadLocationRegistry(invalid);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("default_harness and default_model together");
});

test("key and selector normalization matches the shared machine-adapter contract", () => {
  const root = tempRoot();
  for (const key of ["my_tool", "v2.api"]) {
    const invalid = writeRegistry(root, `${locationHeader}
[[location]]
key = "${key}"
name = "Invalid"
cwd = "/tmp/invalid"
kind = "workspace"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"
`);
    expect(loadLocationRegistry(invalid).ok).toBe(false);
  }

  const collision = writeRegistry(root, `${locationHeader}
[[location]]
key = "one"
name = "One"
aliases = ["auf-web"]
cwd = "/tmp/one"
kind = "workspace"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"

[[location]]
key = "two"
name = "Two"
aliases = ["auf web"]
cwd = "/tmp/two"
kind = "workspace"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"
`);
  expect(loadLocationRegistry(collision).ok).toBe(false);
});

test("rejects traversing cwd and case-insensitive eligible-host duplicates", () => {
  const root = tempRoot();
  const cases = [
    `cwd = "~/one/../two"\nkind = "workspace"\neligible_hosts = ["${LAPTOP_HOST}"]\npreferred_host = "${LAPTOP_HOST}"`,
    `cwd = "/tmp/project"\nkind = "workspace"\neligible_hosts = ["${LAPTOP_HOST}", "milads-m3-2"]\npreferred_host = "${LAPTOP_HOST}"`,
  ];
  for (const body of cases) {
    const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "project"
name = "Project"
${body}
status = "active"
`);
    expect(loadLocationRegistry(path).ok).toBe(false);
  }
});

test("default_host must be eligible for at least one location", () => {
  const root = tempRoot();
  const path = writeRegistry(root, `version = 1

default_host = "${MINI_HOST}"

[[location]]
key = "laptop-only"
name = "Laptop only"
cwd = "/tmp/laptop-only"
kind = "workspace"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"
`);
  const loaded = loadLocationRegistry(path);
  expect(loaded.ok).toBe(false);
  if (!loaded.ok) expect(loaded.error.message).toContain("is not eligible for any location");
});

test("repo locations must resolve to an actual Git repository root", () => {
  const root = tempRoot();
  const repo = join(root, "repo");
  mkdirSync(repo);
  initRepo(repo);
  const child = join(repo, "child");
  mkdirSync(child);
  const notRepo = join(root, "not-repo");
  mkdirSync(notRepo);
  const base: LaunchLocation = {
    key: "repo",
    name: "Repo",
    aliases: [],
    cwd: repo,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: LAPTOP_HOST,
    defaultHarness: null,
    defaultModel: null,
    status: "active",
  };
  expect(resolveLocationForHost(base, LAPTOP_HOST).ok).toBe(true);
  const childResult = resolveLocationForHost({ ...base, cwd: child }, LAPTOP_HOST);
  expect(childResult.ok).toBe(false);
  if (!childResult.ok) expect(childResult.error.message).toContain("not the Git repository root");
  const missingResult = resolveLocationForHost({ ...base, cwd: notRepo }, LAPTOP_HOST);
  expect(missingResult.ok).toBe(false);
  if (!missingResult.ok) expect(missingResult.error.message).toContain("not a Git repository root");
});

test("registration rejects temporary, task-local, and linked-worktree paths", () => {
  const root = tempRoot();
  const temporaryRepo = join(root, "temporary-repo");
  mkdirSync(temporaryRepo);
  initRepo(temporaryRepo);
  const temporary = registerLocation(join(root, "temporary.toml"), {
    defaultHost: LAPTOP_HOST,
    key: "temporary",
    name: "Temporary",
    aliases: [],
    cwd: temporaryRepo,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: LAPTOP_HOST,
    defaultHarness: null,
    defaultModel: null,
  });
  expect(temporary.ok).toBe(false);
  if (!temporary.ok) expect(temporary.error.message).toContain("is temporary");

  const taskLocal = join(root, ".claude", "worktrees", "task");
  mkdirSync(taskLocal, { recursive: true });
  const taskLocalResult = registerLocation(join(root, "task-local.toml"), {
    defaultHost: LAPTOP_HOST,
    key: "task-local",
    name: "Task local",
    aliases: [],
    cwd: taskLocal,
    kind: "workspace",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: LAPTOP_HOST,
    defaultHarness: null,
    defaultModel: null,
  }, TEST_REGISTRATION_POLICY);
  expect(taskLocalResult.ok).toBe(false);
  if (!taskLocalResult.ok) expect(taskLocalResult.error.message).toContain("is task-local");

  const main = join(root, "main");
  const linked = join(root, "linked");
  mkdirSync(main);
  initRepo(main);
  execFileSync("git", ["-C", main, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", main, "config", "user.name", "Test"]);
  writeFileSync(join(main, "README.md"), "main\n");
  execFileSync("git", ["-C", main, "add", "README.md"]);
  execFileSync("git", ["-C", main, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feature/test", linked]);
  const linkedResult = registerLocation(join(root, "linked.toml"), {
    defaultHost: LAPTOP_HOST,
    key: "linked",
    name: "Linked",
    aliases: [],
    cwd: linked,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: LAPTOP_HOST,
    defaultHarness: null,
    defaultModel: null,
  }, TEST_REGISTRATION_POLICY);
  expect(linkedResult.ok).toBe(false);
  if (!linkedResult.ok) expect(linkedResult.error.message).toContain("linked Git worktree");
});

test("matches exact aliases before partial token overlap and excludes retired entries", () => {
  const root = tempRoot();
  const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "ccs"
name = "CCS"
aliases = ["claude sessions", "session catalogue"]
cwd = "/tmp/ccs"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"

[[location]]
key = "sessions-docs"
name = "Session documentation"
aliases = ["session docs"]
cwd = "/tmp/docs"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"

[[location]]
key = "old"
name = "Old sessions"
aliases = ["legacy sessions"]
cwd = "/tmp/old"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "retired"
`);
  const loaded = loadLocationRegistry(path);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;

  const exact = matchLocations(loaded.value, "work on the session catalogue router");
  expect(exact[0]?.location.key).toBe("ccs");
  expect(exact[0]?.score).toBeGreaterThan(0.9);
  expect(exact.some((candidate) => candidate.location.key === "old")).toBe(false);
});

test("register creates and round-trips default_host, then retirement preserves it", () => {
  const root = tempRoot();
  const registryPath = join(root, "locations.toml");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  initRepo(cwd);

  const registered = registerLocation(registryPath, {
    defaultHost: MINI_HOST,
    key: "project",
    name: "Project",
    aliases: ["my project"],
    cwd,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST, MINI_HOST],
    preferredHost: MINI_HOST,
    defaultHarness: null,
    defaultModel: null,
  }, TEST_REGISTRATION_POLICY);
  expect(registered.ok).toBe(true);
  const registeredContent = readFileSync(registryPath, "utf8");
  expect(registeredContent).toContain(`default_host = "${MINI_HOST}"`);
  expect(registeredContent).toContain('key = "project"');

  const retired = retireLocation(registryPath, "project");
  expect(retired.ok).toBe(true);
  if (!retired.ok) return;
  expect(retired.value.status).toBe("retired");

  const loaded = loadLocationRegistry(registryPath);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  expect(loaded.value.defaultHost).toBe(MINI_HOST);
  expect(loaded.value.locations[0]?.status).toBe("retired");
});

test("register and retire preserve curated comments, order, and file mode", () => {
  const root = tempRoot();
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  initRepo(first);
  initRepo(second);
  const path = writeRegistry(root, `# registry heading
${locationHeader}
# first location comment
[[location]]
key = "first"
name = "First"
aliases = []
cwd = "${first}"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active" # preserve this comment
`);
  chmodSync(path, 0o640);

  const registered = registerLocation(path, {
    defaultHost: MINI_HOST,
    key: "second",
    name: "Second",
    aliases: [],
    cwd: second,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: LAPTOP_HOST,
    defaultHarness: null,
    defaultModel: null,
  }, TEST_REGISTRATION_POLICY);
  expect(registered.ok).toBe(true);
  const afterRegister = readFileSync(path, "utf8");
  expect(afterRegister).toContain("# registry heading");
  expect(afterRegister).toContain("# first location comment");
  expect(afterRegister.indexOf('key = "first"')).toBeLessThan(afterRegister.indexOf('key = "second"'));
  expect(statSync(path).mode & 0o777).toBe(0o640);

  const retired = retireLocation(path, "first");
  expect(retired.ok).toBe(true);
  const afterRetire = readFileSync(path, "utf8");
  expect(afterRetire).toContain('status = "retired" # preserve this comment');
  expect(afterRetire).toContain("# registry heading");
  expect(afterRetire.indexOf('key = "first"')).toBeLessThan(afterRetire.indexOf('key = "second"'));
  expect(statSync(path).mode & 0o777).toBe(0o640);
});

test("register through the runtime symlink preserves the machine-adapter-managed link", () => {
  const root = tempRoot();
  const shared = writeRegistry(root, locationHeader);
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir);
  const runtimeLink = join(runtimeDir, "locations.toml");
  symlinkSync(shared, runtimeLink);
  const cwd = join(root, "project");
  mkdirSync(cwd);
  initRepo(cwd);

  const registered = registerLocation(runtimeLink, {
    defaultHost: MINI_HOST,
    key: "project",
    name: "Project",
    aliases: [],
    cwd,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: null,
    defaultHarness: null,
    defaultModel: null,
  }, TEST_REGISTRATION_POLICY);
  expect(registered.ok).toBe(true);
  expect(lstatSync(runtimeLink).isSymbolicLink()).toBe(true);
  expect(readFileSync(shared, "utf8")).toContain(`default_host = "${LAPTOP_HOST}"`);
  expect(readFileSync(shared, "utf8")).toContain('key = "project"');
});

test("register refuses a missing cwd and selector collisions", () => {
  const root = tempRoot();
  const cwd = join(root, "one");
  mkdirSync(cwd);
  initRepo(cwd);
  const path = writeRegistry(root, `${locationHeader}
[[location]]
key = "one"
name = "One"
aliases = ["shared"]
cwd = "${cwd}"
kind = "repo"
eligible_hosts = ["${LAPTOP_HOST}"]
preferred_host = "${LAPTOP_HOST}"
status = "active"
`);

  const missing = registerLocation(path, {
    defaultHost: MINI_HOST,
    key: "missing",
    name: "Missing",
    aliases: [],
    cwd: join(root, "absent"),
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: null,
    defaultHarness: null,
    defaultModel: null,
  });
  expect(missing.ok).toBe(false);

  const collisionCwd = join(root, "two");
  mkdirSync(collisionCwd);
  initRepo(collisionCwd);
  const collision = registerLocation(path, {
    defaultHost: MINI_HOST,
    key: "two",
    name: "Two",
    aliases: ["shared"],
    cwd: collisionCwd,
    kind: "repo",
    eligibleHosts: [LAPTOP_HOST],
    preferredHost: null,
    defaultHarness: null,
    defaultModel: null,
  }, TEST_REGISTRATION_POLICY);
  expect(collision.ok).toBe(false);
});
