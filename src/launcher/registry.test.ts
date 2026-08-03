import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCHER_REGISTRY_VERSION,
  loadLauncherRegistry,
  mergeLauncherFleet,
  type LauncherRegistryEntry,
} from "./registry.ts";

function withRegistry<T>(contents: string, fn: (path: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ccs-launcher-registry-"));
  const path = join(root, "launchers.toml");
  writeFileSync(path, contents);
  try {
    return fn(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SHARED_TOML = `
version = 1

[[launcher]]
name = "claudex"
binary = "claudex"
serves = ["*"]
env = { ANTHROPIC_BASE_URL = "http://127.0.0.1:8317", ANTHROPIC_AUTH_TOKEN = "@file:~/.cli-proxy-api-key" }

[[launcher]]
name = "claude-native"
binary = "claude-native"
serves = ["claude-*"]
clears = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]
`;

describe("loadLauncherRegistry", () => {
  test("loads a shared fleet, keeping the @file: reference rather than a secret", () => {
    withRegistry(SHARED_TOML, (path) => {
      const loaded = loadLauncherRegistry(path);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) return;
      expect(loaded.value.version).toBe(LAUNCHER_REGISTRY_VERSION);
      expect(loaded.value.launcher.map((entry) => entry.name)).toEqual([
        "claudex",
        "claude-native",
      ]);
      // The committed file names the token file; it never holds the token.
      expect(loaded.value.launcher[0]?.env.ANTHROPIC_AUTH_TOKEN).toBe("@file:~/.cli-proxy-api-key");
      expect(loaded.value.launcher[1]?.clears).toEqual([
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
      ]);
    });
  });

  test("a MISSING registry is not an error — config.toml is then the whole fleet", () => {
    const loaded = loadLauncherRegistry(join(tmpdir(), "ccs-definitely-absent-launchers.toml"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBeNull();
  });

  test("malformed TOML fails LOUDLY rather than silently yielding a partial fleet", () => {
    withRegistry("version = 1\n[[launcher\n", (path) => {
      const loaded = loadLauncherRegistry(path);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.error.message).toContain("invalid TOML");
    });
  });

  test("a duplicate name is refused — `--via` would be ambiguous", () => {
    withRegistry(
      `version = 1\n[[launcher]]\nname = "a"\nbinary = "a"\n[[launcher]]\nname = "a"\nbinary = "b"\n`,
      (path) => {
        const loaded = loadLauncherRegistry(path);
        expect(loaded.ok).toBe(false);
        if (loaded.ok) return;
        expect(loaded.error.message).toContain("duplicate launcher name");
      },
    );
  });

  test("a FUTURE schema version refuses rather than misreading it", () => {
    withRegistry(`version = ${LAUNCHER_REGISTRY_VERSION + 1}\n`, (path) => {
      const loaded = loadLauncherRegistry(path);
      expect(loaded.ok).toBe(false);
      if (loaded.ok) return;
      expect(loaded.error.message).toContain("upgrade ccs");
    });
  });
});

describe("mergeLauncherFleet", () => {
  const shared: readonly LauncherRegistryEntry[] = [
    { name: "claudex", binary: "claudex", serves: ["*"], env: { A: "shared" }, clears: [] },
    { name: "claude-native", binary: "claude-native", serves: ["claude-*"], env: {}, clears: ["A"] },
  ];

  test("with no machine entries the shared fleet is the fleet", () => {
    expect(mergeLauncherFleet(shared, []).map((entry) => entry.name)).toEqual([
      "claudex",
      "claude-native",
    ]);
  });

  test("a machine entry overrides the shared one BY NAME, keeping registry order", () => {
    const merged = mergeLauncherFleet(shared, [
      { name: "claudex", binary: "claudex", serves: ["*"], env: { A: "machine" }, clears: [] },
    ]);
    expect(merged.map((entry) => entry.name)).toEqual(["claudex", "claude-native"]);
    // Order is a versioned decision (it is the tie-break for a session with no model history),
    // so an override must not shuffle the daily driver to the end of the list.
    expect(merged[0]?.env).toEqual({ A: "machine" });
  });

  test("a host-only launcher is appended — per-machine facts stay possible", () => {
    const merged = mergeLauncherFleet(shared, [
      { name: "claude-gpt", binary: "claude-gpt", serves: ["gpt-*"], env: {}, clears: [] },
    ]);
    expect(merged.map((entry) => entry.name)).toEqual([
      "claudex",
      "claude-native",
      "claude-gpt",
    ]);
  });
});
