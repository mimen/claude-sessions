import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, upsertRole, setRole, setSystem, getRow } from "../catalogue/db.ts";
import { composeClaudeMd } from "./compose-claude-md.ts";

/**
 * End-to-end composition against a temp config tree + in-memory catalogue. $CCS_CONFIG_ROOT and
 * $CCS_ROOT point at temp dirs so nothing touches the real trees.
 */
function withTree<T>(fn: (cfg: string, db: ReturnType<typeof openCatalogue>) => T): T {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-cmd-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-cmd-rt-"));
  const prevCfg = process.env.CCS_CONFIG_ROOT, prevRt = process.env.CCS_ROOT;
  process.env.CCS_CONFIG_ROOT = cfg;
  process.env.CCS_ROOT = rt;
  const db = openCatalogue(":memory:");
  try { return fn(cfg, db); }
  finally {
    db.close();
    prevCfg === undefined ? delete process.env.CCS_CONFIG_ROOT : (process.env.CCS_CONFIG_ROOT = prevCfg);
    prevRt === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prevRt);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(rt, { recursive: true, force: true });
  }
}

const NOW = "2026-07-10T00:00:00Z";
const writeMd = (root: string, sub: string, content: string) => {
  const d = join(root, sub, ".ccs-hooks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "claude-md.md"), content);
};

test("composes cluster + role sections into one context block", () => {
  withTree((cfg, db) => {
    const roleHome = join(cfg, "clusters", "pr-watch", "roles", "pr-agent");
    upsertRole(db, { role: "pr-agent", cluster: "pr-watch", homeDir: roleHome, now: NOW });
    writeMd(cfg, "clusters/pr-watch", "## constitution\n<!-- ccs:floor -->\npush != post");
    writeMd(roleHome, "", "## role-brief\nown one PR"); // roleHome IS the base; no sub-path
    setSystem(db, "sess-1", "pr-watch", NOW);
    setRole(db, "sess-1", "pr-agent", NOW);
    const out = composeClaudeMd(db, openRow(db, "sess-1"));
    expect(out.context).toContain("## constitution");
    expect(out.context).toContain("push != post");
    expect(out.context).toContain("## role-brief");
    expect(out.context).toContain("own one PR");
    expect(out.degraded).toBe(false);
  });
});

test("no config tree -> null context, not degraded", () => {
  withTree((cfg, db) => {
    upsertRole(db, { role: "pr-agent", cluster: "pr-watch", homeDir: join(cfg, "x"), now: NOW });
    setSystem(db, "sess-2", "pr-watch", NOW);
    setRole(db, "sess-2", "pr-agent", NOW);
    const out = composeClaudeMd(db, openRow(db, "sess-2"));
    expect(out.context).toBeNull();
    expect(out.degraded).toBe(false);
  });
});

// tiny helper: read a row back
function openRow(db: ReturnType<typeof openCatalogue>, id: string) {
  const r = getRow(db, id);
  if (!r) throw new Error("row not found");
  return r;
}
