import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue, upsertRole, setRole, setSystem, setResumeCommand, getRow } from "../catalogue/db.ts";
import { runStartActions, type ActionHandler, type StartActionCtx } from "./start-actions.ts";
import { writeMessage } from "../inbox/inbox.ts";

const NOW = "2026-07-10T00:00:00Z";

function withTree<T>(fn: (cfg: string, rt: string, db: ReturnType<typeof openCatalogue>) => T): T {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-sa-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-sa-rt-"));
  const pc = process.env.CCS_CONFIG_ROOT, pr = process.env.CCS_ROOT;
  process.env.CCS_CONFIG_ROOT = cfg;
  process.env.CCS_ROOT = rt;
  const db = openCatalogue(":memory:");
  try { return fn(cfg, rt, db); }
  finally {
    db.close();
    pc === undefined ? delete process.env.CCS_CONFIG_ROOT : (process.env.CCS_CONFIG_ROOT = pc);
    pr === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = pr);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(rt, { recursive: true, force: true });
  }
}

const writeStart = (root: string, sub: string, actions: object) => {
  const d = join(root, sub, ".ccs-hooks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "start.json"), JSON.stringify({ actions }));
};

function ctxFor(db: ReturnType<typeof openCatalogue>, id: string, source = "startup"): StartActionCtx {
  const row = getRow(db, id);
  if (!row) throw new Error("no row");
  return { db, row, source };
}

test("runs actions in merged order via injected handlers", () => {
  withTree((cfg, _rt, db) => {
    const home = join(cfg, "clusters/pr-watch/roles/control");
    upsertRole(db, { role: "control", cluster: "pr-watch", homeDir: home, now: NOW });
    writeStart(cfg, "clusters/pr-watch/roles/control", [
      { name: "arm", order: 10 }, { name: "load-board", order: 30 }, { name: "greet", order: 20 },
    ]);
    setSystem(db, "s1", "pr-watch", NOW); setRole(db, "s1", "control", NOW);
    const seen: string[] = [];
    const handlers: Record<string, ActionHandler> = {
      arm: () => (seen.push("arm"), { context: null }),
      greet: () => (seen.push("greet"), { context: "hi" }),
      "load-board": () => (seen.push("load-board"), { context: null }),
    };
    const out = runStartActions(ctxFor(db, "s1"), handlers);
    expect(seen).toEqual(["arm", "greet", "load-board"]); // by order 10,20,30
    expect(out.context).toBe("hi");
    expect(out.ran).toEqual(["arm", "greet", "load-board"]);
  });
});

test("an action with no handler is recorded, others still run (fail-open)", () => {
  withTree((cfg, _rt, db) => {
    const home = join(cfg, "clusters/pr-watch/roles/control");
    upsertRole(db, { role: "control", cluster: "pr-watch", homeDir: home, now: NOW });
    writeStart(cfg, "clusters/pr-watch/roles/control", [{ name: "known" }, { name: "mystery" }]);
    setSystem(db, "s2", "pr-watch", NOW); setRole(db, "s2", "control", NOW);
    const out = runStartActions(ctxFor(db, "s2"), { known: () => ({ context: "ok" }) });
    expect(out.ran).toEqual(["known"]);
    expect(out.errors[0]).toContain("no handler");
    expect(out.context).toBe("ok");
  });
});

test("a throwing action is caught; the run continues", () => {
  withTree((cfg, _rt, db) => {
    const home = join(cfg, "clusters/pr-watch/roles/control");
    upsertRole(db, { role: "control", cluster: "pr-watch", homeDir: home, now: NOW });
    writeStart(cfg, "clusters/pr-watch/roles/control", [{ name: "boom" }, { name: "fine" }]);
    setSystem(db, "s3", "pr-watch", NOW); setRole(db, "s3", "control", NOW);
    const out = runStartActions(ctxFor(db, "s3"), {
      boom: () => { throw new Error("kaboom"); },
      fine: () => ({ context: "still ran" }),
    });
    expect(out.errors[0]).toContain("kaboom");
    expect(out.context).toBe("still ran");
  });
});

// ── built-in handlers (arm + drain-inbox), real paths ──────────────────────────
import { BUILTIN_ACTIONS } from "./start-actions.ts";

test("built-in arm: surfaces the resume_command only on resume", () => {
  withTree((cfg, _rt, db) => {
    upsertRole(db, { role: "control", cluster: "pr-watch", homeDir: join(cfg, "x"), now: NOW });
    setSystem(db, "s4", "pr-watch", NOW); setRole(db, "s4", "control", NOW);
    setResumeCommand(db, "s4", "/loop 15m /pr-watch-control", NOW);
    const arm = BUILTIN_ACTIONS.arm!;
    expect(arm({ name: "arm" }, ctxFor(db, "s4", "startup")).context).toBeNull(); // not on startup
    expect(arm({ name: "arm" }, ctxFor(db, "s4", "resume")).context).toContain("/loop 15m /pr-watch-control");
  });
});

test("built-in drain-inbox: executes the drain and returns the content", () => {
  withTree((_cfg, rt, db) => {
    upsertRole(db, { role: "pr-agent", cluster: "pr-watch", homeDir: "/x", now: NOW });
    setSystem(db, "s5", "pr-watch", NOW); setRole(db, "s5", "pr-agent", NOW);
    // seed a message in the identity's inbox dir (matches responsibilityOf → identityDir layout)
    const idDir = join(rt, "clusters", "pr-watch", "identities", "pr-agent");
    writeMessage(idDir, "scout", "PR #12080 got a review comment", NOW);
    const out = BUILTIN_ACTIONS["drain-inbox"]!({ name: "drain-inbox" }, ctxFor(db, "s5"));
    expect(out.context).toContain("1 inbox message");
    expect(out.context).toContain("PR #12080 got a review comment");
    // sender is derived from the filename by drain(); with a dashed ISO stamp it currently
    // includes the stamp tail (a pre-existing inbox.ts parsing quirk, out of scope here) —
    // assert the sender name is present, not its exact prefix.
    expect(out.context).toContain("scout");
  });
});

test("built-in drain-inbox: empty inbox -> null context", () => {
  withTree((_cfg, _rt, db) => {
    upsertRole(db, { role: "pr-agent", cluster: "pr-watch", homeDir: "/x", now: NOW });
    setSystem(db, "s6", "pr-watch", NOW); setRole(db, "s6", "pr-agent", NOW);
    const out = BUILTIN_ACTIONS["drain-inbox"]!({ name: "drain-inbox" }, ctxFor(db, "s6"));
    expect(out.context).toBeNull();
  });
});
