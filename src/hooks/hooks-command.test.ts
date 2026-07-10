import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksCommand } from "./hooks-command.ts";

/** Point $CCS_CONFIG_ROOT + $CCS_ROOT at temp trees, run fn, restore. */
function withRoots<T>(fn: (cfg: string, rt: string) => T): T {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-lint-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-lint-rt-"));
  const prevCfg = process.env.CCS_CONFIG_ROOT, prevRt = process.env.CCS_ROOT;
  process.env.CCS_CONFIG_ROOT = cfg;
  process.env.CCS_ROOT = rt;
  try { return fn(cfg, rt); }
  finally {
    prevCfg === undefined ? delete process.env.CCS_CONFIG_ROOT : (process.env.CCS_CONFIG_ROOT = prevCfg);
    prevRt === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prevRt);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(rt, { recursive: true, force: true });
  }
}

const writeHook = (root: string, sub: string, file: string, content = "{}") => {
  const d = join(root, sub, ".ccs-hooks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, file), content);
};

test("lint: a clean tree with valid hook files passes", () => {
  withRoots((cfg) => {
    writeHook(cfg, "clusters/pr-watch", "meta-update.json");
    writeHook(cfg, "clusters/pr-watch", "claude-md.md", "## x\nbody");
    expect(hooksCommand(["lint"])).toBe(0);
  });
});

test("lint: an unknown hook-type file fails", () => {
  withRoots((cfg) => {
    writeHook(cfg, "clusters/pr-watch", "not-a-type.json");
    expect(hooksCommand(["lint"])).toBe(1);
  });
});

test("lint: a non-.md/.json file in a hooks dir fails", () => {
  withRoots((cfg) => {
    writeHook(cfg, "clusters/pr-watch", "meta-update.yaml");
    expect(hooksCommand(["lint"])).toBe(1);
  });
});

test("lint: two formats for one slot fails (collision)", () => {
  withRoots((cfg) => {
    writeHook(cfg, "roles/x", "meta-update.json");
    writeHook(cfg, "roles/x", "meta-update.md", "## a\nb");
    expect(hooksCommand(["lint"])).toBe(1);
  });
});

test("explain: bad usage returns 1", () => {
  expect(hooksCommand(["explain"])).toBe(1);
});

test("unknown subcommand returns 1", () => {
  expect(hooksCommand(["frobnicate"])).toBe(1);
});

test("lint: a meta-update field with no known writer is a dead contract (fails)", () => {
  withRoots((cfg) => {
    writeHook(cfg, "clusters/pr-watch", "meta-update.json", JSON.stringify({ fields: ["updated_at", "bogus_field"] }));
    expect(hooksCommand(["lint"])).toBe(1);
  });
});

test("lint: a meta-update with only known fields passes", () => {
  withRoots((cfg) => {
    writeHook(cfg, "clusters/pr-watch", "meta-update.json", JSON.stringify({ fields: ["updated_at", "phase", "pr_state"] }));
    expect(hooksCommand(["lint"])).toBe(0);
  });
});
