import { test, expect } from "bun:test";
import { loadConfig } from "../config.ts";
import { resolveEngine, buildEngine, type EngineName } from "./engine.ts";

function makeConfig() {
  const r = loadConfig("/nonexistent-ccs-engine-test.toml");
  if (!r.ok) throw r.error;
  return r.value;
}

/** A config whose engine binaries are names we control the availability of via PATH tricks. */
function configWithBinaries(codexBin: string, claudeBin: string) {
  const c = makeConfig();
  return {
    ...c,
    inference: {
      ...c.inference,
      codex: { ...c.inference.codex, binary: codexBin },
      claude: { ...c.inference.claude, binary: claudeBin },
    },
  };
}

const ENV = "CCS_INFERENCE_ENGINE";
function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[ENV];
    else process.env[ENV] = prev;
  }
}

test("resolveEngine reports null when no engine binary is installed", () => {
  const config = configWithBinaries("definitely-not-a-real-codex-xyz", "definitely-not-a-real-claude-xyz");
  withEnv(undefined, () => {
    const sel = resolveEngine(config);
    expect(sel.name).toBeNull();
    expect(sel.available).toEqual([]);
  });
});

test("auto picks the only installed engine (codex preferred order)", () => {
  // `sh` always exists on PATH; use it as a stand-in "installed" binary for codex.
  const config = configWithBinaries("sh", "definitely-not-a-real-claude-xyz");
  withEnv(undefined, () => {
    const sel = resolveEngine(config);
    expect(sel.name).toBe("codex");
    expect(sel.available).toEqual(["codex"]);
    expect(sel.fellBack).toBe(false);
  });
});

test("explicit request that isn't installed falls back to the available one", () => {
  const config = configWithBinaries("definitely-not-a-real-codex-xyz", "sh");
  withEnv(undefined, () => {
    const sel = resolveEngine({ ...config, inference: { ...config.inference, engine: "codex" } });
    expect(sel.name).toBe("claude");
    expect(sel.requested).toBe("codex");
    expect(sel.fellBack).toBe(true);
  });
});

test("CCS_INFERENCE_ENGINE env overrides config", () => {
  const config = configWithBinaries("sh", "sh"); // both "installed"
  withEnv("claude", () => {
    const sel = resolveEngine(config);
    expect(sel.name).toBe("claude");
    expect(sel.available).toEqual(["codex", "claude"]);
  });
});

test("TUI override is used when env is unset", () => {
  const config = configWithBinaries("sh", "sh");
  withEnv(undefined, () => {
    const sel = resolveEngine(config, "claude" as EngineName);
    expect(sel.name).toBe("claude");
  });
});

test("buildEngine returns the named backend", () => {
  const config = makeConfig();
  expect(buildEngine("codex", config).name).toBe("codex");
  expect(buildEngine("claude", config).name).toBe("claude");
});
