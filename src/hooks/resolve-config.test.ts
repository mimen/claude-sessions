import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, parseMd } from "./resolve-config.ts";
import type { ResolveCtx } from "./resolve-levels.ts";
import type { CatalogueRow } from "../catalogue/db.ts";

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s1", resumeId: null, customTitle: null, kind: "session",
    completed: false, archived: false, parkedTaskId: null, key: null,
    parentSessionId: null, role: null, resumeCommand: null, project: null,
    system: null, gusWork: null, workUnitId: null, epicId: null, statusLine: null, meta: {}, stage: null, activity: null, notes: null, updatedAt: null,
    prNumber: null, prRepo: null, prBranch: null, prState: null, prHeadSha: null,
    ...over,
  };
}

/** Build a temp config tree; return an ojb with the ctx + a writer for a level's hook file. */
function fixture() {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-rt-"));
  const roleHome = join(cfg, "clusters", "pr-watch", "roles", "pr-agent");
  const ctx: ResolveCtx = { configRoot: cfg, runtimeRoot: rt, roleHomeDir: (r) => (r === "pr-agent" ? roleHome : null) };
  const write = (dir: string, type: string, ext: string, content: string) => {
    const d = join(dir, ".ccs-hooks");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${type}.${ext}`), content);
  };
  return {
    ctx, write, cfg, rt, roleHome,
    clusterDir: join(cfg, "clusters", "pr-watch"),
    epicDir: join(cfg, "clusters", "pr-watch", "epics", "e1"),
    cleanup: () => { rmSync(cfg, { recursive: true, force: true }); rmSync(rt, { recursive: true, force: true }); },
  };
}

test("meta-update: unions field sets across user + cluster + role layers", () => {
  const f = fixture();
  try {
    f.write(f.cfg, "meta-update", "json", JSON.stringify({ fields: ["updated_at", "phase"] }));
    f.write(f.clusterDir, "meta-update", "json", JSON.stringify({ fields: ["phase", "pr_state"] }));
    f.write(f.roleHome, "meta-update", "json", JSON.stringify({ fields: ["result"] }));
    const r = resolveConfig(row({ system: "pr-watch", role: "pr-agent" }), "meta-update", f.ctx);
    expect(r.effective).toEqual(["updated_at", "phase", "pr_state", "result"]);
    expect(r.degraded).toBe(false);
  } finally { f.cleanup(); }
});

test("absent files contribute nothing (no error, not degraded)", () => {
  const f = fixture();
  try {
    f.write(f.cfg, "meta-update", "json", JSON.stringify({ fields: ["updated_at"] }));
    const r = resolveConfig(row({ system: "pr-watch", role: "pr-agent" }), "meta-update", f.ctx);
    expect(r.effective).toEqual(["updated_at"]); // only the user level had a file
    expect(r.degraded).toBe(false);
  } finally { f.cleanup(); }
});

test("a corrupt layer fails THAT layer closed — valid layers still merge, session degraded", () => {
  const f = fixture();
  try {
    f.write(f.cfg, "meta-update", "json", JSON.stringify({ fields: ["updated_at"] }));
    f.write(f.roleHome, "meta-update", "json", "{ this is not json");
    const r = resolveConfig(row({ system: "pr-watch", role: "pr-agent" }), "meta-update", f.ctx);
    expect(r.effective).toEqual(["updated_at"]); // valid user layer survives
    expect(r.degraded).toBe(true);
    expect(r.errors[0]).toContain("unparseable");
  } finally { f.cleanup(); }
});

test("two formats for the same slot is an error (one format per slot, ADR-0045)", () => {
  const f = fixture();
  try {
    f.write(f.roleHome, "meta-update", "json", JSON.stringify({ fields: ["a"] }));
    f.write(f.roleHome, "meta-update", "md", "## x\nbody");
    const r = resolveConfig(row({ system: "pr-watch", role: "pr-agent" }), "meta-update", f.ctx);
    expect(r.degraded).toBe(true);
    expect(r.errors[0]).toContain("multiple formats");
  } finally { f.cleanup(); }
});

test("claude-md: sections merge across levels with floor protection", () => {
  const f = fixture();
  try {
    f.write(f.clusterDir, "claude-md", "md", "## constitution\n<!-- ccs:floor -->\npush != post");
    f.write(f.roleHome, "claude-md", "md", "## constitution\n<!-- ccs:op=replace -->\nsneaky\n\n## role-brief\nown one PR");
    const r = resolveConfig(row({ system: "pr-watch", role: "pr-agent" }), "claude-md", f.ctx);
    const secs = r.effective as Array<{ id: string; body: string }>;
    const constitution = secs.find((s) => s.id === "constitution")!;
    expect(constitution.body).toContain("push != post"); // floor survived
    expect(constitution.body).toContain("sneaky"); // replace downgraded to append
    expect(secs.find((s) => s.id === "role-brief")).toBeDefined();
  } finally { f.cleanup(); }
});

test("most-specific: role's config wins over cluster's", () => {
  const f = fixture();
  try {
    f.write(f.clusterDir, "cmux-paint", "json", JSON.stringify({ tab: "generic" }));
    f.write(f.roleHome, "cmux-paint", "json", JSON.stringify({ tab: "worker" }));
    const r = resolveConfig(row({ system: "pr-watch", role: "pr-agent" }), "cmux-paint", f.ctx);
    expect(r.effective).toEqual({ tab: "worker" });
  } finally { f.cleanup(); }
});

test("unknown hook type yields a clean error, not a throw", () => {
  const f = fixture();
  try {
    const r = resolveConfig(row({ system: "pr-watch" }), "not-a-type", f.ctx);
    expect(r.effective).toBeNull();
    expect(r.errors[0]).toContain("unknown hook type");
  } finally { f.cleanup(); }
});

test("parseMd: headings become sections; preamble before first heading is captured", () => {
  const p = parseMd("intro text\n\n## identity\nyou are ccs\n\n## gate\nreviews first");
  expect(p.sections.map((s) => s.id)).toEqual(["preamble", "identity", "gate"]);
  expect(p.sections[0]!.body).toBe("intro text");
});

test("parseMd: floor + op markers are parsed onto the section", () => {
  const p = parseMd("## constitution\n<!-- ccs:floor -->\npush != post");
  expect(p.sections[0]!.floor).toBe(true);
});
