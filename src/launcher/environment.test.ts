import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { ok } from "../result.ts";
import {
  compileLauncherEnvDirectives,
  compileLauncherEnvSpec,
  launcherEnvSpecFilename,
  parseLauncherEnvValue,
  resolveLauncherEnv,
} from "./environment.ts";

describe("parseLauncherEnvValue", () => {
  test("plain values are literals", () => {
    const parsed = parseLauncherEnvValue("http://127.0.0.1:8317");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ kind: "literal", value: "http://127.0.0.1:8317" });
  });

  test("@file: names a secret file and expands ~", () => {
    const parsed = parseLauncherEnvValue("@file:~/.cli-proxy-api-key");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ kind: "file", path: join(homedir(), ".cli-proxy-api-key") });
  });

  test("@literal: escapes a value that really starts with @file:", () => {
    const parsed = parseLauncherEnvValue("@literal:@file:not-a-path");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ kind: "literal", value: "@file:not-a-path" });
  });

  test("@file: with no path is an error", () => {
    expect(parseLauncherEnvValue("@file:").ok).toBe(false);
  });
});

describe("compileLauncherEnvSpec", () => {
  test("emits clears before sets so a launcher may clear a family then re-assert one", () => {
    const spec = compileLauncherEnvSpec({
      name: "claudex",
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
      clears: ["ANTHROPIC_API_KEY"],
    });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const lines = spec.value.trim().split("\n").filter((line) => !line.startsWith("#"));
    expect(lines).toEqual([
      "clear ANTHROPIC_API_KEY",
      "set ANTHROPIC_BASE_URL=http://127.0.0.1:8317",
    ]);
  });

  test("a file-backed value compiles to setfile with the path, never the secret", () => {
    const spec = compileLauncherEnvSpec({
      name: "claudex",
      env: { ANTHROPIC_AUTH_TOKEN: "@file:/tmp/some-key" },
      clears: [],
    });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    expect(spec.value).toContain("setfile ANTHROPIC_AUTH_TOKEN=/tmp/some-key");
  });

  test("claude-native compiles to a pure clears list with no assignments", () => {
    const spec = compileLauncherEnvSpec({
      name: "claude-native",
      env: {},
      clears: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    expect(spec.value).toContain("clear ANTHROPIC_BASE_URL");
    expect(spec.value).toContain("clear ANTHROPIC_AUTH_TOKEN");
    expect(spec.value).not.toContain("\nset ");
  });

  test("an invalid key is refused rather than written into the spec", () => {
    const spec = compileLauncherEnvSpec({ name: "x", env: { "BAD KEY": "v" }, clears: [] });
    expect(spec.ok).toBe(false);
    if (spec.ok) return;
    expect(spec.error.message).toContain("invalid environment key");
  });

  test("a newline in a value is refused — it would forge a second directive", () => {
    const spec = compileLauncherEnvSpec({
      name: "x",
      env: { GOOD: "a\nclear PATH" },
      clears: [],
    });
    expect(spec.ok).toBe(false);
    if (spec.ok) return;
    expect(spec.error.message).toContain("single line");
  });
});

describe("resolveLauncherEnv", () => {
  const readSecret = (path: string) => ok(`secret-from:${path}`);

  test("claude-native resolves to unsets, which is the whole escape hatch", () => {
    const resolved = resolveLauncherEnv(
      {
        name: "claude-native",
        env: {},
        clears: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
      },
      readSecret,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.assign).toEqual({});
    expect(resolved.value.unset).toEqual(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
  });

  test("a secret is read at resolve time, so config.toml never holds it", () => {
    const resolved = resolveLauncherEnv(
      {
        name: "claudex",
        env: { ANTHROPIC_AUTH_TOKEN: "@file:/tmp/key" },
        clears: [],
      },
      readSecret,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.assign).toEqual({ ANTHROPIC_AUTH_TOKEN: "secret-from:/tmp/key" });
  });

  test("an unreadable secret FAILS rather than launching unauthenticated", () => {
    const resolved = resolveLauncherEnv(
      { name: "claudex", env: { ANTHROPIC_AUTH_TOKEN: "@file:/tmp/missing" }, clears: [] },
      () => ({ ok: false, error: new Error("ENOENT") }),
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.message).toContain("ANTHROPIC_AUTH_TOKEN");
  });

  test("a launcher may clear a family and re-assert one member — the set wins", () => {
    const resolved = resolveLauncherEnv(
      {
        name: "mixed",
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" },
        clears: ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"],
      },
      readSecret,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    // `clears` is emitted first, so the later assignment wins and only the untouched name is unset.
    expect(resolved.value.assign).toEqual({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8317" });
    expect(resolved.value.unset).toEqual(["ANTHROPIC_API_KEY"]);
  });

  test("the spec file and the resolved env are two renderings of ONE directive list", () => {
    const input = {
      name: "claude-native",
      env: { CCS_MARKER: "kept" },
      clears: ["ANTHROPIC_BASE_URL"],
    };
    const directives = compileLauncherEnvDirectives(input);
    const spec = compileLauncherEnvSpec(input);
    const resolved = resolveLauncherEnv(input, readSecret);
    expect(directives.ok && spec.ok && resolved.ok).toBe(true);
    if (!directives.ok || !spec.ok || !resolved.ok) return;

    // Whatever the shim's spec clears, the spawn paths must unset — this equality is the
    // single-rule guarantee that kept `--via` and the shim from drifting apart.
    const clearedInSpec = spec.value
      .split("\n")
      .filter((line) => line.startsWith("clear "))
      .map((line) => line.slice("clear ".length));
    expect(clearedInSpec).toEqual([...resolved.value.unset]);
    expect(directives.value).toEqual([
      { verb: "clear", key: "ANTHROPIC_BASE_URL" },
      { verb: "set", key: "CCS_MARKER", value: "kept" },
    ]);
  });
});

describe("launcherEnvSpecFilename", () => {
  test("accepts ordinary launcher names", () => {
    const filename = launcherEnvSpecFilename("claude-native");
    expect(filename.ok).toBe(true);
    if (!filename.ok) return;
    expect(filename.value).toBe("claude-native.env");
  });

  test("refuses names that could escape the spec directory", () => {
    expect(launcherEnvSpecFilename("../evil").ok).toBe(false);
    expect(launcherEnvSpecFilename("..").ok).toBe(false);
    expect(launcherEnvSpecFilename("a/b").ok).toBe(false);
  });
});
