import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogueRow } from "../catalogue/db.ts";
import { composeClaudeMd } from "./compose-claude-md.ts";

/**
 * End-to-end composition against a temp config tree. Roles are FILES now (ADR-0050): writing a
 * role's `.ccs-hooks/claude-md.md` under clusters/<c>/roles/<role>/ IS the role definition — no
 * registry setup. $CCS_CONFIG_ROOT / $CCS_ROOT point at temp dirs so nothing touches real trees.
 */
function withTree<T>(fn: (cfg: string) => T): T {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-cmd-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-cmd-rt-"));
  const prevCfg = process.env.CCS_CONFIG_ROOT, prevRt = process.env.CCS_ROOT;
  process.env.CCS_CONFIG_ROOT = cfg;
  process.env.CCS_ROOT = rt;
  try { return fn(cfg); }
  finally {
    prevCfg === undefined ? delete process.env.CCS_CONFIG_ROOT : (process.env.CCS_CONFIG_ROOT = prevCfg);
    prevRt === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prevRt);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(rt, { recursive: true, force: true });
  }
}

const writeMd = (root: string, sub: string, content: string) => {
  const d = sub ? join(root, sub, ".ccs-hooks") : join(root, ".ccs-hooks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "claude-md.md"), content);
};

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, event: null, key: null, parentSessionId: null,
    skill: null, role: null, resumeCommand: null, project: null, system: null, gusWork: null, workUnitId: null,
    epicId: null, phase: null, statusLine: null, meta: {}, stage: null, activity: null, notes: null, updatedAt: null, prNumber: null, prRepo: null,
    prBranch: null, prState: null, prHeadSha: null, ...over,
  };
}

test("composes cluster + role sections into one context block", () => {
  withTree((cfg) => {
    // the role package: its dir + a role.toml make it resolvable; the .ccs-hooks/claude-md is its context
    const roleHome = join(cfg, "clusters", "pr-watch", "roles", "pr-agent");
    mkdirSync(roleHome, { recursive: true });
    writeFileSync(join(roleHome, "role.toml"), 'kind = "session"\n');
    writeMd(cfg, "clusters/pr-watch", "## constitution\n<!-- ccs:floor -->\npush != post");
    writeMd(roleHome, "", "## role-brief\nown one PR");
    const out = composeClaudeMd(row({ system: "pr-watch", role: "pr-agent" }));
    expect(out.context).toContain("## constitution");
    expect(out.context).toContain("push != post");
    expect(out.context).toContain("## role-brief");
    expect(out.context).toContain("own one PR");
    expect(out.degraded).toBe(false);
  });
});

test("no config tree -> null context, not degraded", () => {
  withTree(() => {
    const out = composeClaudeMd(row({ system: "pr-watch", role: "pr-agent" }));
    expect(out.context).toBeNull();
    expect(out.degraded).toBe(false);
  });
});
