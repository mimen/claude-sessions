import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { expandHome, DEFAULT_STORE_PATH } from "./paths.ts";

test("missing config falls back to defaults", () => {
  const result = loadConfig(join(tmpdir(), "definitely-not-here-ccs.toml"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.store.path).toBe(DEFAULT_STORE_PATH);
  expect(result.value.resume.target).toBe("auto");
  expect(result.value.titler.concurrency).toBe(3);
  expect(result.value.inference.engine).toBe("auto");
  expect(result.value.inference.codex.binary).toBe("codex");
  expect(result.value.inference.claude.binary).toBe("claude");
  expect(result.value.inference.claude.model).toBe("haiku");
});

test("inference engine can be forced in config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, `[inference]\nengine = "claude"\n[inference.claude]\nmodel = "sonnet"\n`);
  const result = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.inference.engine).toBe("claude");
  expect(result.value.inference.claude.model).toBe("sonnet");
});

test("user values override defaults and ~ expands", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  const path = join(dir, "config.toml");
  writeFileSync(
    path,
    `[store]\npath = "~/custom-store"\n[resume]\ntarget = "cmux"\n[titler]\nconcurrency = 6\n`,
  );
  const result = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.store.path).toBe(join(homedir(), "custom-store"));
  expect(result.value.resume.target).toBe("cmux");
  expect(result.value.titler.concurrency).toBe(6);
});

test("invalid enum value is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, `[resume]\ntarget = "nonsense"\n`);
  const result = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });

  expect(result.ok).toBe(false);
});

test("expandHome handles ~, ~/x, and absolute paths", () => {
  expect(expandHome("~")).toBe(homedir());
  expect(expandHome("~/a/b")).toBe(join(homedir(), "a/b"));
  expect(expandHome("/abs/path")).toBe("/abs/path");
});
