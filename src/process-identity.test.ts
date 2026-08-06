import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const identityBin = join(repoRoot, "bin", "ccs-process-identity");
const ccsBin = join(repoRoot, "bin", "ccs");

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  delete env.PROCID;
  delete env.PROCID_REF;
  delete env.PROCID_OFF;
  delete env.GIT_CONFIG_GLOBAL;
  return { ...env, ...overrides };
}

function runIdentity(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const result = Bun.spawnSync({
    cmd: [identityBin, ...args],
    cwd,
    env: cleanEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}

function makeRepo(root: string, defaultBranch = "main"): void {
  mkdirSync(root);
  git(root, ["init", "-b", defaultBranch]);
  git(root, ["config", "user.name", "CCS Test"]);
  git(root, ["config", "user.email", "ccs-test@example.com"]);
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
}

test("formats canonical ASCII lowercase alphanumeric-hyphen role and ref segments", () => {
  expect(runIdentity(tmpdir(), ["É__Resume---__Cluster.V2!!"], { PROCID_REF: "--Å/Feature___--01.--" })).toBe(
    "ccs:resume-cluster-v2@feature-01",
  );
  expect(runIdentity(tmpdir(), ["--help"])).toBe("ccs:main");
});

test("rejects an explicit PROCID_REF that normalizes empty", () => {
  for (const ref of ["---", "___", "Å"]) {
    const result = Bun.spawnSync({
      cmd: [identityBin, "ls"],
      cwd: tmpdir(),
      env: cleanEnv({ PROCID_REF: ref }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("does not contain an ASCII alphanumeric character");
  }
});

test("PROCID overrides the full identity and PROCID_REF overrides git context", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-precedence-"));
  try {
    makeRepo(join(root, "repo"));
    git(join(root, "repo"), ["switch", "-c", "Feature/Git-Ref"]);

    expect(runIdentity(join(root, "repo"), ["ls"], { PROCID_REF: "Explicit Ref" })).toBe(
      "ccs:ls@explicit-ref",
    );
    expect(
      runIdentity(join(root, "repo"), ["ls"], {
        PROCID: "ccs:complete@identity-7",
        PROCID_REF: "ignored",
      }),
    ).toBe("ccs:complete@identity-7");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed PROCID overrides instead of normalizing them", () => {
  for (const procid of [
    "other:role@ref",
    "ccs:Uppercase@ref",
    "ccs:role@two words",
    "ccs:role_name@ref",
    "ccs:role@ref.name",
    "ccs:-role@ref",
    "ccs:role@ref-",
    "ccs:foo--bar@ref",
    "ccs:role@foo--bar",
  ]) {
    const result = Bun.spawnSync({
      cmd: [identityBin, "ls"],
      cwd: tmpdir(),
      env: cleanEnv({ PROCID: procid }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("invalid PROCID");
  }
});

test("omits a ref for a primary checkout on its default branch", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-primary-"));
  try {
    const repo = join(root, "repo");
    makeRepo(repo);
    expect(runIdentity(repo, ["tree"])).toBe("ccs:tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ignores a global init.defaultBranch whose branch does not exist locally", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-global-default-"));
  try {
    const repo = join(root, "repo");
    const globalConfig = join(root, "global.gitconfig");
    makeRepo(repo, "master");
    writeFileSync(globalConfig, "[init]\n\tdefaultBranch = main\n");
    expect(runIdentity(repo, ["tree"], { GIT_CONFIG_GLOBAL: globalConfig })).toBe("ccs:tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("treats a sole unusual local branch as the default", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-sole-default-"));
  try {
    const repo = join(root, "repo");
    const globalConfig = join(root, "empty.gitconfig");
    makeRepo(repo, "trunk");
    writeFileSync(globalConfig, "");
    expect(runIdentity(repo, ["tree"], { GIT_CONFIG_GLOBAL: globalConfig })).toBe("ccs:tree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("omits only an unusual resolved default branch", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-unusual-default-"));
  try {
    const repo = join(root, "repo");
    makeRepo(repo, "trunk");
    git(repo, ["config", "init.defaultBranch", "trunk"]);
    expect(runIdentity(repo, ["tree"])).toBe("ccs:tree");

    git(repo, ["switch", "-c", "main"]);
    expect(runIdentity(repo, ["tree"])).toBe("ccs:tree@main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uses a sanitized non-default branch in a primary checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-branch-"));
  try {
    const repo = join(root, "repo");
    makeRepo(repo);
    git(repo, ["switch", "-c", "Feature/Process-ID"]);
    expect(runIdentity(repo, ["doctor"])).toBe("ccs:doctor@feature-process-id");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes repository and linked-worktree basenames before stripping the repository prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-worktree-"));
  try {
    const repo = join(root, "My Repo");
    const worktree = join(root, "MY repo-Linked Pilot");
    makeRepo(repo);
    git(repo, ["worktree", "add", "-b", "unrelated-branch", worktree]);
    expect(runIdentity(worktree, ["resume"])).toBe("ccs:resume@linked-pilot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit bun bin/ccs remains compatible through the polyglot entrypoint", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ccsBin, "--version"],
    cwd: repoRoot,
    env: cleanEnv({ PATH: "/usr/bin:/bin" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toBe("0.1.0\n");
});

test("package ccs script uses the direct identity-bearing entrypoint", () => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "run", "ccs", "--version"],
    cwd: repoRoot,
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("0.1.0\n");
});

test("direct launcher reports a missing Bun executable and exits 127", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-no-bun-"));
  try {
    const result = Bun.spawnSync({
      cmd: [ccsBin, "--version"],
      cwd: repoRoot,
      env: cleanEnv({ PATH: root }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(127);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe("ccs: bun not found in PATH\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct launcher exposes the canonical native argv0 through exec -a", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "ccs-process-id-argv0-"));
  const child = Bun.spawn({
    cmd: [ccsBin],
    cwd: repoRoot,
    env: cleanEnv({ CCS_ROOT: runtimeRoot, TERM: "xterm", PROCID: "ccs:main@argv0-test" }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const expectedIdentity = "ccs:main@argv0-test ";
    const deadline = Date.now() + 2_000;
    let lastArgv = "";
    let lastPsError = "";
    while (Date.now() < deadline) {
      const ps = Bun.spawnSync({
        cmd: ["ps", "-p", String(child.pid), "-o", "args="],
        stdout: "pipe",
        stderr: "pipe",
      });
      lastArgv = ps.stdout.toString();
      lastPsError = ps.stderr.toString();
      if (ps.exitCode === 0 && lastArgv.includes(expectedIdentity)) break;
      await Bun.sleep(25);
    }
    expect(
      lastArgv,
      `expected argv identity before timeout; last argv=${JSON.stringify(lastArgv)}; ps stderr=${JSON.stringify(lastPsError)}`,
    ).toStartWith(expectedIdentity);
  } finally {
    child.kill();
    await child.exited;
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("PROCID_OFF bypasses identity resolution while preserving launcher arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-off-"));
  try {
    const fakeBinDir = join(root, "bin");
    const capturePath = join(root, "argv.txt");
    mkdirSync(fakeBinDir);
    const fakeBun = join(fakeBinDir, "bun");
    writeFileSync(fakeBun, "#!/bin/zsh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"\n");
    chmodSync(fakeBun, 0o755);

    const result = Bun.spawnSync({
      cmd: [ccsBin, "ls", "--auxiliary"],
      cwd: repoRoot,
      env: cleanEnv({
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        PROCID_OFF: "1",
        PROCID: "invalid override that must not be resolved",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(capturePath, "utf8")).toBe(`${join(repoRoot, "bin", "ccs")}\nls\n--auxiliary\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity controls do not leak into the Bun CLI environment", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-env-"));
  try {
    const fakeBinDir = join(root, "bin");
    const capturePath = join(root, "env.txt");
    mkdirSync(fakeBinDir);
    const fakeBun = join(fakeBinDir, "bun");
    writeFileSync(
      fakeBun,
      "#!/bin/zsh -f\nprintf 'PROCID=%s\\nPROCID_REF=%s\\nPROCID_OFF=%s\\n' \"${PROCID-unset}\" \"${PROCID_REF-unset}\" \"${PROCID_OFF-unset}\" > \"$CAPTURE_PATH\"\n",
    );
    chmodSync(fakeBun, 0o755);

    const result = Bun.spawnSync({
      cmd: [ccsBin, "ls"],
      cwd: repoRoot,
      env: cleanEnv({
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        CAPTURE_PATH: capturePath,
        PROCID: "ccs:ls@test-ref",
        PROCID_REF: "ignored-ref",
        PROCID_OFF: "0",
      }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(capturePath, "utf8")).toBe("PROCID=unset\nPROCID_REF=unset\nPROCID_OFF=unset\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bin/ccs preserves every CLI argument when launching Bun", () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-process-id-forwarding-"));
  try {
    const fakeBinDir = join(root, "bin");
    const capturePath = join(root, "argv.txt");
    mkdirSync(fakeBinDir);
    const fakeBun = join(fakeBinDir, "bun");
    writeFileSync(fakeBun, "#!/bin/zsh\nprintf '%s\\n' \"$@\" > \"$CAPTURE_PATH\"\n");
    chmodSync(fakeBun, 0o755);

    const forwarded = ["delegate", "seat name", "--prompt", "text with spaces", "--", "-literal"];
    const result = Bun.spawnSync({
      cmd: [ccsBin, ...forwarded],
      cwd: repoRoot,
      env: cleanEnv({ PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`, CAPTURE_PATH: capturePath }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    expect(readFileSync(capturePath, "utf8")).toBe(
      `${join(repoRoot, "bin", "ccs")}\n${forwarded.join("\n")}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
