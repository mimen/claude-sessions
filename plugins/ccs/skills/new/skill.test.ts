import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skill = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
const wrapperPath = join(import.meta.dir, "scripts", "ccs-new");
const wrapper = readFileSync(wrapperPath, "utf8");
const roots: string[] = [];
const promptSessions: string[] = [];

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const sessionId of promptSessions.splice(0)) {
    rmSync(join("/tmp/ccs-new-prompts", sessionId), { recursive: true, force: true });
  }
});

function fakeCcs(): { readonly directory: string; readonly argsPath: string } {
  const directory = mkdtempSync(join(tmpdir(), "ccs-new-wrapper-"));
  roots.push(directory);
  const argsPath = join(directory, "args.json");
  const executable = join(directory, "ccs");
  writeFileSync(executable, `#!/usr/bin/env bash\npython3 - "$@" <<'PY'\nimport json, os, sys\nwith open(os.environ["CCS_NEW_TEST_ARGS"], "w") as handle:\n    json.dump(sys.argv[1:], handle)\nprint('{"status":"fixture"}')\nPY\n`);
  chmodSync(executable, 0o755);
  return { directory, argsPath };
}

function runWrapper(args: readonly string[], environment: Readonly<Record<string, string>> = {}): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([wrapperPath, ...args], {
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("ccs:new isolates arbitrary prompt text from shell commands", () => {
  expect(skill).toContain("Edit(//tmp/ccs-new-prompts/**)");
  expect(skill).toContain('prepare --session-id "${CLAUDE_SESSION_ID}"');
  expect(skill).toContain("Never interpolate the prompt into a Bash command");
  expect(skill).not.toContain('--query "$ARGUMENTS"');
  expect(skill).not.toContain('--prompt "$ARGUMENTS"');

  const sessionId = randomUUID();
  promptSessions.push(sessionId);
  const prepared = runWrapper(["prepare", "--session-id", sessionId]);
  expect(prepared.exitCode).toBe(0);
  const promptPath = new TextDecoder().decode(prepared.stdout).trim();
  const injectedPath = join(tmpdir(), `ccs-new-injected-${sessionId}`);
  const prompt = 'review "quoted" work $(touch ' + injectedPath + ') and `backticks`';
  writeFileSync(promptPath, prompt);

  const fake = fakeCcs();
  const routed = runWrapper(["route", "--session-id", sessionId], {
    PATH: `${fake.directory}:${process.env.PATH ?? ""}`,
    CCS_NEW_TEST_ARGS: fake.argsPath,
  });
  expect(routed.exitCode).toBe(0);
  expect(existsSync(injectedPath)).toBe(false);
  const args = JSON.parse(readFileSync(fake.argsPath, "utf8")) as string[];
  expect(args).toEqual(["location", "match", `--query=${prompt}`, "--json"]);
});

test("ccs:new uses capability-aware placement and post-success registration", () => {
  expect(skill).toContain("current worktree, branch, checkout, or uncommitted changes");
  expect(skill).toContain("Mini preference never overrides current-worktree state");
  expect(skill).toContain("they are not the placement recommendation");
  expect(skill).toContain("look up that host's capabilities in `registered_hosts`");
  expect(skill).toContain("--require-capability");
  expect(skill).toContain("--model <canonical-model-id>");
  expect(skill).toContain("Register an unregistered explicit path only after");
  expect(skill).toContain("Do not register after any failed or uncertain receipt");
  expect(skill).toContain("Never register a linked worktree");
});

test("ccs:new permits local fallback only after explicit safe confirmation", () => {
  expect(skill).toContain("Never retry automatically and never silently fall back");
  expect(skill).toContain("CCS returned no `workspace_ref`");
  expect(skill).toContain("The user explicitly chooses the current host through `AskUserQuestion`");
  expect(skill).toContain("Never fall back locally after CCS returns a workspace reference");
});

test("ccs:new reports structured local and pending remote receipts honestly", () => {
  expect(skill).toContain("full session ID and title");
  expect(skill).toContain("recoverable session ID and blocker");
  expect(skill).toContain("report `session_id: pending` exactly when returned");
  expect(skill).toContain("repeat the receipt's uncertainty verbatim");
  expect(skill).toContain("do not claim that reservation, model launch, or prompt delivery succeeded");
});

test("ccs-new launch forwards a protected prompt and requests JSON", () => {
  expect(wrapper).toContain("ccs-new launch --session-id <claude-session-id>");
  expect(wrapper).toContain("--prompt \"$prompt\" --json");

  const sessionId = randomUUID();
  promptSessions.push(sessionId);
  const prepared = runWrapper(["prepare", "--session-id", sessionId]);
  const promptPath = new TextDecoder().decode(prepared.stdout).trim();
  writeFileSync(promptPath, "launch this safely");
  const fake = fakeCcs();
  const launched = runWrapper([
    "launch", "--session-id", sessionId,
    "--host", "Milads-M3-2",
    "--cwd", "/tmp/project",
    "--model", "gpt-5.6-sol",
  ], {
    PATH: `${fake.directory}:${process.env.PATH ?? ""}`,
    CCS_NEW_TEST_ARGS: fake.argsPath,
  });
  expect(launched.exitCode).toBe(0);
  const args = JSON.parse(readFileSync(fake.argsPath, "utf8")) as string[];
  expect(args).toEqual([
    "session", "new", "--top-level", "--permission-mode", "acceptEdits",
    "--host", "Milads-M3-2", "--cwd", "/tmp/project", "--model", "gpt-5.6-sol",
    "--prompt", "launch this safely", "--json",
  ]);
});
