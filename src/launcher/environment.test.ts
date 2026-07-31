import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compileLauncherEnvSpec,
  launcherEnvSpecFilename,
  parseLauncherEnvValue,
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
