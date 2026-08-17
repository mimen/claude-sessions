/**
 * The shim is the hottest path on the machine — a defect here means no Claude Code session
 * starts. These tests RUN the real `bin/ccs-claude-shim` against a fake raw binary that prints
 * its own environment, so what is asserted is the environment Claude would actually receive.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SHIM = resolve(import.meta.dir, "../../bin/ccs-claude-shim");

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly root: string;
  readonly envDir: string;
  readonly rawClaude: string;
}

/** A fixture whose "raw claude" dumps the environment it was exec'd with. */
function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "ccs-shim-env-"));
  fixtures.push(root);
  const envDir = join(root, "launcher-env");
  mkdirSync(envDir, { recursive: true });
  const rawClaude = join(root, "raw-claude");
  writeFileSync(rawClaude, "#!/bin/sh\nexec /usr/bin/env\n");
  chmodSync(rawClaude, 0o755);
  return { root, envDir, rawClaude };
}

interface RunResult {
  readonly env: Readonly<Record<string, string>>;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Run the shim with registration deliberately skipped (`--version` is a builtin invocation, the
 * same short-circuit `claude --version` takes today) so these assertions isolate the ENVIRONMENT
 * step from the birth-registration step.
 */
function run(h: Harness, extra: Record<string, string>): RunResult {
  const result = Bun.spawnSync([SHIM, "--version"], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: h.root,
      CCS_RAW_CLAUDE_PATH: h.rawClaude,
      CCS_LAUNCHER_ENV_DIR: h.envDir,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const env: Record<string, string> = {};
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    env[line.slice(0, at)] = line.slice(at + 1);
  }
  return { env, stderr: new TextDecoder().decode(result.stderr), exitCode: result.exitCode ?? -1 };
}

function writeSpec(h: Harness, name: string, contents: string): void {
  writeFileSync(join(h.envDir, `${name}.env`), contents);
}

function writeDefault(h: Harness, name: string): void {
  writeFileSync(join(h.envDir, "default"), `${name}\n`);
}

describe("shim launcher environment", () => {
  test("applies the default launcher's environment", () => {
    const h = harness();
    writeSpec(h, "claudex", "set ANTHROPIC_BASE_URL=http://127.0.0.1:8317\nset SLOT=opus\n");
    writeDefault(h, "claudex");

    const result = run(h, {});
    expect(result.exitCode).toBe(0);
    expect(result.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8317");
    expect(result.env.SLOT).toBe("opus");
  });

  test("CCS_FORCE_HARNESS overrides the default so a wrapper can name itself", () => {
    const h = harness();
    writeSpec(h, "claudex", "set HARNESS=claudex\n");
    writeSpec(h, "claude-gpt", "set HARNESS=claude-gpt\n");
    writeDefault(h, "claudex");

    const result = run(h, { CCS_FORCE_HARNESS: "claude-gpt" });
    expect(result.env.HARNESS).toBe("claude-gpt");
  });

  test("the selector is dropped before exec so a child re-resolves the default", () => {
    const h = harness();
    writeSpec(h, "claude-gpt", "set HARNESS=claude-gpt\n");
    writeDefault(h, "claude-gpt");

    const result = run(h, { CCS_FORCE_HARNESS: "claude-gpt" });
    expect(result.env.CCS_FORCE_HARNESS).toBeUndefined();
  });

  test("claude-native genuinely clears inherited gateway variables", () => {
    const h = harness();
    writeSpec(
      h,
      "claude-native",
      [
        "clear ANTHROPIC_BASE_URL",
        "clear ANTHROPIC_AUTH_TOKEN",
        "clear ANTHROPIC_DEFAULT_OPUS_MODEL",
        "clear CLAUDE_CODE_AUTO_COMPACT_WINDOW",
        "clear CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "",
      ].join("\n"),
    );
    writeDefault(h, "claudex");

    const result = run(h, {
      CCS_FORCE_HARNESS: "claude-native",
      // Exactly the situation the escape hatch exists for: launched from inside a gateway
      // session, so the gateway route is already in the inherited environment.
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
      ANTHROPIC_AUTH_TOKEN: "gateway-token",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5[1m]",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "921000",
      KEEP_ME: "untouched",
    });

    expect(result.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    expect(result.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(result.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
    // Clearing is scoped to what the launcher declares; unrelated variables survive.
    expect(result.env.KEEP_ME).toBe("untouched");
  });

  test("an unknown launcher name warns and applies nothing, but still launches", () => {
    const h = harness();
    writeSpec(h, "claudex", "set HARNESS=claudex\n");
    writeDefault(h, "claudex");

    const result = run(h, { CCS_FORCE_HARNESS: "nonexistent" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('no launcher environment for "nonexistent"');
    expect(result.env.HARNESS).toBeUndefined();
  });

  test("a launcher name that could escape the spec directory is refused", () => {
    const h = harness();
    writeSpec(h, "claudex", "set HARNESS=claudex\n");
    writeDefault(h, "claudex");

    const result = run(h, { CCS_FORCE_HARNESS: "../../etc/passwd" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("invalid launcher name");
    expect(result.env.HARNESS).toBeUndefined();
  });

  test("setfile reads the value from the named file, first line only", () => {
    const h = harness();
    const secret = join(h.root, "api-key");
    writeFileSync(secret, "sk-secret-value\n");
    writeSpec(h, "claudex", `setfile ANTHROPIC_AUTH_TOKEN=${secret}\n`);
    writeDefault(h, "claudex");

    const result = run(h, {});
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-secret-value");
  });

  test("an unreadable secret file warns instead of exporting an empty credential", () => {
    const h = harness();
    writeSpec(h, "claudex", `setfile ANTHROPIC_AUTH_TOKEN=${join(h.root, "missing")}\n`);
    writeDefault(h, "claudex");

    const result = run(h, {});
    expect(result.stderr).toContain("cannot read ANTHROPIC_AUTH_TOKEN");
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  test("no default and no force harness leaves the environment untouched", () => {
    const h = harness();
    const result = run(h, { INHERITED: "yes" });
    expect(result.exitCode).toBe(0);
    expect(result.env.INHERITED).toBe("yes");
    expect(result.stderr).not.toContain("no launcher environment");
  });

  test("malformed directives are skipped without stopping the good ones", () => {
    const h = harness();
    writeSpec(
      h,
      "claudex",
      [
        "# a comment",
        "",
        "bogus VERB",
        "set",
        "set NO_EQUALS_SIGN",
        "set BAD KEY=x",
        "set GOOD=value",
        "",
      ].join("\n"),
    );
    writeDefault(h, "claudex");

    const result = run(h, {});
    expect(result.exitCode).toBe(0);
    expect(result.env.GOOD).toBe("value");
  });

  test("values keep spaces, quotes, and shell metacharacters verbatim", () => {
    const h = harness();
    writeSpec(h, "claudex", "set TRICKY=a b $(echo hi) 'q' \"d\" *\n");
    writeDefault(h, "claudex");

    const result = run(h, {});
    expect(result.env.TRICKY).toBe("a b $(echo hi) 'q' \"d\" *");
  });
});
