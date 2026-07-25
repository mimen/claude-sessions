import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { expandHome, DEFAULT_STORE_PATH, HOST_REGISTRY_PATH, LOCATION_REGISTRY_PATH } from "./paths.ts";

function darwinRuntime(execFileSync: (file: string, args: readonly string[]) => string) {
  return {
    platform: "darwin" as const,
    hostname: () => "Mac.attlocal.net",
    execFileSync,
  };
}

test("missing config falls back to defaults", () => {
  const result = loadConfig(join(tmpdir(), "definitely-not-here-ccs.toml"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.store.path).toBe(DEFAULT_STORE_PATH);
  expect(result.value.resume.target).toBe("auto");
  expect(result.value.routing.registry).toBe(LOCATION_REGISTRY_PATH());
  expect(result.value.routing.hosts).toBe(HOST_REGISTRY_PATH());
  expect(result.value.titler.concurrency).toBe(3);
  expect(result.value.inference.engine).toBe("auto");
  expect(result.value.inference.codex.binary).toBe("codex");
  expect(result.value.inference.claude.binary).toBe("claude");
  expect(result.value.inference.claude.model).toBe("haiku");
});

test("explicit host label wins without consulting platform identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, `[host]\nlabel = "Milads-Mac-mini"\n`);
  const fail = (): never => {
    throw new Error("host identity fallback should not run");
  };

  const result = loadConfig(path, {
    platform: "darwin",
    hostname: fail,
    execFileSync: fail,
  });
  rmSync(dir, { recursive: true, force: true });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.host.label).toBe("Milads-Mac-mini");
});

test("omitted Darwin host label uses scutil LocalHostName", () => {
  const result = loadConfig(
    join(tmpdir(), "definitely-not-here-ccs-host.toml"),
    darwinRuntime((file, args) => {
      expect(file).toBe("/usr/sbin/scutil");
      expect(args).toEqual(["--get", "LocalHostName"]);
      return "Milads-M3-2\n";
    }),
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.host.label).toBe("Milads-M3-2");
});

test("Darwin host identity is cached once per runtime object", () => {
  let calls = 0;
  const runtime = darwinRuntime(() => {
    calls++;
    return "Milads-M3-2\n";
  });
  const path = join(tmpdir(), "definitely-not-here-ccs-host-cache.toml");
  const first = loadConfig(path, runtime);
  const second = loadConfig(path, runtime);
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(calls).toBe(1);
});

test("blank Darwin host label uses scutil LocalHostName", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccs-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, `[host]\nlabel = "   "\n`);

  const result = loadConfig(path, darwinRuntime(() => "Milads-M3-2\n"));
  rmSync(dir, { recursive: true, force: true });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.host.label).toBe("Milads-M3-2");
});

test("Darwin host label resolution fails when scutil fails", () => {
  const result = loadConfig(
    join(tmpdir(), "definitely-not-here-ccs-scutil-failure.toml"),
    darwinRuntime(() => {
      throw new Error("scutil unavailable");
    }),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("/usr/sbin/scutil --get LocalHostName failed");
  expect(result.error.message).toContain("scutil unavailable");
});

test("Darwin host label resolution fails when scutil returns blank", () => {
  const result = loadConfig(
    join(tmpdir(), "definitely-not-here-ccs-scutil-blank.toml"),
    darwinRuntime(() => " \n"),
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("/usr/sbin/scutil --get LocalHostName returned a blank value");
});

test("omitted non-Darwin host label uses Node hostname", () => {
  const result = loadConfig(join(tmpdir(), "definitely-not-here-ccs-linux-host.toml"), {
    platform: "linux",
    hostname: () => "ccs-linux-host",
    execFileSync: () => {
      throw new Error("scutil must not run outside Darwin");
    },
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.host.label).toBe("ccs-linux-host");
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
    `[store]\npath = "~/custom-store"\n[resume]\ntarget = "cmux"\n[routing]\nregistry = "~/locations.toml"\nhosts = "~/hosts.toml"\n[titler]\nconcurrency = 6\n`,
  );
  const result = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.store.path).toBe(join(homedir(), "custom-store"));
  expect(result.value.resume.target).toBe("cmux");
  expect(result.value.routing.registry).toBe(join(homedir(), "locations.toml"));
  expect(result.value.routing.hosts).toBe(join(homedir(), "hosts.toml"));
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
