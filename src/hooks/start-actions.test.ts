import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalogueRow } from "../catalogue/db.ts";
import { runStartActions, BUILTIN_ACTIONS, type ActionHandler, type StartActionCtx } from "./start-actions.ts";
import { writeMessage } from "../inbox/inbox.ts";
import { readIdentityDoc } from "../state/cluster-state.ts";

const NOW = "2026-07-10T00:00:00Z";

/** $CCS_CONFIG_ROOT / $CCS_ROOT point at temp dirs; roles + start config are FILES (ADR-0050). */
function withTree<T>(fn: (cfg: string, rt: string) => T): T {
  const cfg = mkdtempSync(join(tmpdir(), "ccs-sa-cfg-"));
  const rt = mkdtempSync(join(tmpdir(), "ccs-sa-rt-"));
  const pc = process.env.CCS_CONFIG_ROOT, pr = process.env.CCS_ROOT;
  process.env.CCS_CONFIG_ROOT = cfg;
  process.env.CCS_ROOT = rt;
  try { return fn(cfg, rt); }
  finally {
    pc === undefined ? delete process.env.CCS_CONFIG_ROOT : (process.env.CCS_CONFIG_ROOT = pc);
    pr === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = pr);
    rmSync(cfg, { recursive: true, force: true });
    rmSync(rt, { recursive: true, force: true });
  }
}

const writeStart = (cfg: string, cluster: string, role: string, actions: object) => {
  const d = join(cfg, "clusters", cluster, "roles", role, ".ccs-hooks");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "start.json"), JSON.stringify({ actions }));
};

function row(over: Partial<CatalogueRow>): CatalogueRow {
  return {
    sessionId: "s", resumeId: null, customTitle: null, kind: "session", completed: false,
    archived: false, parkedTaskId: null, key: null, parentSessionId: null,
    role: null, resumeCommand: null, project: null, cluster: "pr-watch", gusWork: null, workUnitId: null,
    groupingId: null, statusLine: null, meta: {}, stage: null, notes: null, updatedAt: null, prNumber: null, prRepo: null,
    prBranch: null, prState: null, prHeadSha: null, identityKey: null, ...over,
  };
}
const ctx = (over: Partial<CatalogueRow>, source = "startup"): StartActionCtx =>
  ({ row: row({ role: "control", ...over }), source });

test("runs actions in merged order via injected handlers", () => {
  withTree((cfg) => {
    writeStart(cfg, "pr-watch", "control", [
      { name: "arm", order: 10 }, { name: "load-board", order: 30 }, { name: "greet", order: 20 },
    ]);
    const seen: string[] = [];
    const handlers: Record<string, ActionHandler> = {
      arm: () => (seen.push("arm"), { context: null }),
      greet: () => (seen.push("greet"), { context: "hi" }),
      "load-board": () => (seen.push("load-board"), { context: null }),
    };
    const out = runStartActions(ctx({}), handlers);
    expect(seen).toEqual(["arm", "greet", "load-board"]); // order 10,20,30
    expect(out.context).toBe("hi");
    expect(out.ran).toEqual(["arm", "greet", "load-board"]);
  });
});

test("an action with no handler is recorded, others still run (fail-open)", () => {
  withTree((cfg) => {
    writeStart(cfg, "pr-watch", "control", [{ name: "known" }, { name: "mystery" }]);
    const out = runStartActions(ctx({}), { known: () => ({ context: "ok" }) });
    expect(out.ran).toEqual(["known"]);
    expect(out.errors[0]).toContain("no handler");
    expect(out.context).toBe("ok");
  });
});

test("a throwing action is caught; the run continues", () => {
  withTree((cfg) => {
    writeStart(cfg, "pr-watch", "control", [{ name: "boom" }, { name: "fine" }]);
    const out = runStartActions(ctx({}), {
      boom: () => { throw new Error("kaboom"); },
      fine: () => ({ context: "still ran" }),
    });
    expect(out.errors[0]).toContain("kaboom");
    expect(out.context).toBe("still ran");
  });
});

test("built-in arm: surfaces the resume_command only on resume", () => {
  const arm = BUILTIN_ACTIONS.arm!;
  const r = { resumeCommand: "/loop 15m /pr-watch-control" };
  expect(arm({ name: "arm" }, ctx(r, "startup")).context).toBeNull(); // not on startup
  expect(arm({ name: "arm" }, ctx(r, "resume")).context).toContain("/loop 15m /pr-watch-control");
});

test("built-in drain-inbox: executes the drain and returns the content", () => {
  withTree((_cfg, rt) => {
    // seed a message in the identity's inbox dir (responsibilityOf → identityDir layout)
    const idDir = join(rt, "clusters", "pr-watch", "identities", "pr-agent");
    writeMessage(idDir, "scout", "PR #12080 got a review comment", NOW);
    const out = BUILTIN_ACTIONS["drain-inbox"]!({ name: "drain-inbox" }, ctx({ role: "pr-agent" }));
    expect(out.context).toContain("1 inbox message");
    expect(out.context).toContain("PR #12080 got a review comment");
    expect(out.context).toContain("from scout:"); // sender from the sentinel header, clean
  });
});

test("built-in drain-inbox: empty inbox -> null context", () => {
  withTree(() => {
    const out = BUILTIN_ACTIONS["drain-inbox"]!({ name: "drain-inbox" }, ctx({ role: "pr-agent" }));
    expect(out.context).toBeNull();
  });
});

// --- catch-up (ADR-0058) ---------------------------------------------------------

const CHANGELOG = `# pr-watch CHANGELOG
version: 2

## adopt prBranch (version 1)
requiresRestart: false
Use the board's prBranch.

## worktree moved (version 2)
requiresRestart: true
cwd relocated; orchestrator restarts you.
`;
const writeChangelog = (cfg: string, cluster: string, text: string) => {
  const d = join(cfg, "clusters", cluster);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "CHANGELOG.md"), text);
};
const seenVersion = (rt: string, cluster: string, role: string): unknown => {
  const doc = readIdentityDoc<{ last_seen_cluster_version?: number }>(
    rt, { cluster, role }, "catch-up",
  );
  return doc?.data?.last_seen_cluster_version;
};

test("catch-up: a fresh identity sees the full changelog window and the stamp advances to current", () => {
  withTree((cfg, rt) => {
    writeChangelog(cfg, "pr-watch", CHANGELOG);
    const out = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, ctx({ role: "control" }));
    expect(out.context).toContain("v0 → v2");
    expect(out.context).toContain("adopt prBranch");
    expect(out.context).toContain("worktree moved");
    expect(out.context).toContain("restart"); // v2 requiresRestart
    expect(seenVersion(rt, "pr-watch", "control")).toBe(2); // stamp advanced only after surfacing
  });
});

test("catch-up: an up-to-date identity is a silent no-op", () => {
  withTree((cfg) => {
    writeChangelog(cfg, "pr-watch", CHANGELOG);
    const c = ctx({ role: "control" });
    BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, c); // first run: advances to 2
    const second = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, c); // already current
    expect(second.context).toBeNull();
  });
});

test("catch-up: idempotent across re-runs at the same version (killed session re-surfaces nothing new)", () => {
  withTree((cfg, rt) => {
    writeChangelog(cfg, "pr-watch", CHANGELOG);
    const c = ctx({ role: "control" });
    const first = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, c);
    expect(first.context).toContain("v0 → v2");
    // stamp is now 2; a fresh start at the same cluster version surfaces nothing
    const again = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, c);
    expect(again.context).toBeNull();
    expect(seenVersion(rt, "pr-watch", "control")).toBe(2);
  });
});

test("catch-up: no cluster on the row → null (nothing to catch up on)", () => {
  withTree((cfg) => {
    writeChangelog(cfg, "pr-watch", CHANGELOG);
    const out = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, ctx({ role: "control", cluster: null }));
    expect(out.context).toBeNull();
  });
});

test("catch-up: cluster ships no CHANGELOG → null", () => {
  withTree(() => {
    const out = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, ctx({ role: "control" }));
    expect(out.context).toBeNull();
  });
});

test("catch-up: after seeing v1, only the newer entry surfaces on a bump to v2", () => {
  withTree((cfg, rt) => {
    // start with a v1-only changelog, catch up (stamp → 1)
    writeChangelog(cfg, "pr-watch", "# c\nversion: 1\n\n## adopt prBranch (version 1)\nrequiresRestart: false\nUse prBranch.\n");
    const c = ctx({ role: "control" });
    BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, c);
    expect(seenVersion(rt, "pr-watch", "control")).toBe(1);
    // bump to v2; only v2 should surface
    writeChangelog(cfg, "pr-watch", CHANGELOG);
    const out = BUILTIN_ACTIONS["catch-up"]!({ name: "catch-up" }, c);
    expect(out.context).toContain("worktree moved");
    expect(out.context).not.toContain("adopt prBranch");
    expect(out.context).toContain("v1 → v2");
    expect(seenVersion(rt, "pr-watch", "control")).toBe(2);
  });
});
