import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db.ts";
import { materializeAllIdentityTables } from "./identity-schema.ts";
import {
  archiveIdentity,
  completeIdentity,
  ensureScratchDir,
  getIdentity,
  identityScratchDir,
  listIdentities,
  mintIdentity,
  sessionsForIdentity,
  setIdentityFields,
} from "./identities.ts";

const NOW = "2026-07-14T12:00:00Z";

/** Build a minimal cluster/roles tree under a tmp config root. */
function seedRoles(root: string): void {
  const dir = join(root, "clusters", "pr-watch", "roles", "pr-agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "role.toml"), 'kind = "session"\nwork_unit = "pr"\n');
  writeFileSync(
    join(dir, "identity-schema.toml"),
    `[columns]
pr_repo   = { type = "text" }
pr_number = { type = "integer", indexed = true }
pr_state  = { type = "text" }
gus_work  = { type = "text" }
`,
  );
  const con = join(root, "clusters", "pr-watch", "roles", "concierge");
  mkdirSync(con, { recursive: true });
  writeFileSync(join(con, "role.toml"), 'kind = "loop"\nwork_unit = "none"\n');
}

describe("identity CRUD", () => {
  test("mint + read a fleet identity, per-role attrs empty until set", () => {
    const cfg = mkdtempSync(join(tmpdir(), "id-cfg-"));
    seedRoles(cfg);
    try {
      const db = openCatalogue(":memory:");
      materializeAllIdentityTables(db, cfg);

      const key = "pr-watch:pr-agent:owner/repo#12345";
      expect(mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW)).toBe(true);
      expect(mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW)).toBe(false);

      const id = getIdentity(db, key, cfg)!;
      expect(id.cluster).toBe("pr-watch");
      expect(id.role).toBe("pr-agent");
      expect(id.kind).toBe("fleet");
      expect(id.attrs).toEqual({});
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });

  describe("mintIdentity rejects malformed identity_key values", () => {
    // Punch-list guarantee: mintIdentity is the ONE authorized minter for
    // rows in `identities`. Junk keys (empty, whitespace-only, newlines,
    // control chars) would poison downstream joins — every "no identity"
    // lookup could accidentally match a phantom "" row. Reject them at
    // mint time so the invariant is a schema-level truth.
    const rejects = [
      { name: "empty string", key: "" },
      { name: "whitespace only", key: "   " },
      { name: "contains newline", key: "pr-watch:pr-agent:x\ny" },
      { name: "contains null byte", key: "pr-watch:pr-agent:\x00" },
      { name: "leading whitespace", key: " pr-watch:pr-agent:x" },
      { name: "trailing whitespace", key: "pr-watch:pr-agent:x " },
    ];
    for (const { name, key } of rejects) {
      test(`rejects: ${name}`, () => {
        const db = openCatalogue(":memory:");
        expect(() =>
          mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW),
        ).toThrow(/identity_key/i);
        const count = (db.query("SELECT COUNT(*) AS n FROM identities").get() as { n: number }).n;
        expect(count).toBe(0);
      });
    }

    test("accepts the canonical shapes we actually use", () => {
      const db = openCatalogue(":memory:");
      // These are the real-world keys used across the codebase; all must
      // continue to mint cleanly after the validation lands.
      const okKeys = [
        "pr-watch:pr-agent:heroku/dashboard#12080",
        "pr-watch:concierge",
        "pr-watch:pr-agent:W-1234567",
        "signal-scout:scout:owner.name/repo-name#1",
      ];
      for (const k of okKeys) {
        expect(mintIdentity(db, k, { cluster: k.split(":")[0]!, role: k.split(":")[1]! }, NOW)).toBe(true);
      }
    });
  });

  test("concurrent mint from 2 processes → exactly one row, no throw (barrier-synced)", async () => {
    // Two OS processes race on the same identity_key. The old code did a
    // SELECT-then-INSERT; both processes saw "not there" during their SELECT
    // and both attempted the raw INSERT — the loser hit `UNIQUE constraint
    // failed: identities.identity_key`. The fix makes the INSERT atomic
    // (`ON CONFLICT DO NOTHING`) so the loser silently no-ops and mintIdentity
    // returns false.
    //
    // We use a filesystem barrier (both children spin until the barrier file
    // exists) to make the race deterministically tight: sqlite serializes
    // writes at the file lock, so even a few-millisecond stagger is enough for
    // the loser's SELECT to observe the winner's INSERT and skip the write —
    // masking the bug. The barrier ensures BOTH SELECTs run before EITHER
    // INSERT commits. Retry 10 rounds to make an accidental serial ordering
    // vanishingly unlikely.
    const cfg = mkdtempSync(join(tmpdir(), "id-cfg-"));
    seedRoles(cfg);
    try {
      for (let round = 0; round < 10; round++) {
        const dbFile = join(cfg, `cat-${round}.db`);
        const barrier = join(cfg, `barrier-${round}`);
        openCatalogue(dbFile).close();

        const key = `pr-watch:pr-agent:owner/repo#race-${round}`;
        const child = `
          import { existsSync } from "node:fs";
          import { openCatalogue } from ${JSON.stringify(join(process.cwd(), "src/catalogue/db.ts"))};
          import { mintIdentity } from ${JSON.stringify(join(process.cwd(), "src/catalogue/identities.ts"))};
          const db = openCatalogue(${JSON.stringify(dbFile)});
          // Busy-wait on the barrier file so both processes cross the line at
          // nearly the same instant.
          while (!existsSync(${JSON.stringify(barrier)})) {}
          try {
            const won = mintIdentity(db, ${JSON.stringify(key)}, { cluster: "pr-watch", role: "pr-agent" }, ${JSON.stringify(NOW)});
            process.stdout.write(JSON.stringify({ ok: true, won }));
          } catch (e) {
            process.stdout.write(JSON.stringify({ ok: false, err: (e as Error).message }));
          } finally {
            db.close();
          }
        `;

        const pA = Bun.spawn(["bun", "-e", child], { stdout: "pipe", stderr: "pipe" });
        const pB = Bun.spawn(["bun", "-e", child], { stdout: "pipe", stderr: "pipe" });
        // Give both processes ~50ms to boot + hit the barrier.
        await Bun.sleep(50);
        writeFileSync(barrier, "");

        const [outA, outB] = await Promise.all([
          new Response(pA.stdout).text(),
          new Response(pB.stdout).text(),
        ]);
        const rA = JSON.parse(outA);
        const rB = JSON.parse(outB);

        expect(rA.ok).toBe(true);
        expect(rB.ok).toBe(true);
        expect([rA.won, rB.won].sort()).toEqual([false, true]);

        const db = openCatalogue(dbFile);
        const count = (db
          .query("SELECT COUNT(*) AS n FROM identities WHERE identity_key = $k")
          .get({ $k: key }) as { n: number }).n;
        expect(count).toBe(1);
        db.close();
      }
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  }, 30_000);

  test("mint a core identity — kind auto-derived from key shape", () => {
    const cfg = mkdtempSync(join(tmpdir(), "id-cfg-"));
    seedRoles(cfg);
    try {
      const db = openCatalogue(":memory:");
      const key = "pr-watch:concierge";
      mintIdentity(db, key, { cluster: "pr-watch", role: "concierge" }, NOW);
      const id = getIdentity(db, key)!;
      expect(id.kind).toBe("core");
      expect(id.attrs).toEqual({});
    } finally {
      rmSync(cfg, { recursive: true, force: true });
    }
  });
});

describe("setIdentityFields", () => {
  function setup() {
    const cfg = mkdtempSync(join(tmpdir(), "id-cfg-"));
    seedRoles(cfg);
    const db = openCatalogue(":memory:");
    materializeAllIdentityTables(db, cfg);
    const key = "pr-watch:pr-agent:owner/repo#12345";
    mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    return { db, cfg, key, cleanup: () => rmSync(cfg, { recursive: true, force: true }) };
  }

  test("sets a universal column (stage)", () => {
    const { db, cfg, key, cleanup } = setup();
    try {
      const n = setIdentityFields(db, key, { stage: "milad-review" }, NOW, cfg);
      expect(n).toBe(1);
      expect(getIdentity(db, key, cfg)!.stage).toBe("milad-review");
    } finally {
      cleanup();
    }
  });

  test("sets a per-role attribute (pr_number)", () => {
    const { db, cfg, key, cleanup } = setup();
    try {
      const n = setIdentityFields(db, key, { pr_repo: "owner/repo", pr_number: 12345 }, NOW, cfg);
      expect(n).toBe(2);
      const id = getIdentity(db, key, cfg)!;
      expect(id.attrs.pr_repo).toBe("owner/repo");
      expect(id.attrs.pr_number).toBe(12345);
    } finally {
      cleanup();
    }
  });

  test("merges into meta with dotted keys, and clears a meta key on null", () => {
    const { db, cfg, key, cleanup } = setup();
    try {
      setIdentityFields(db, key, { "meta.milad_review": "approved", "meta.foo": 42 }, NOW, cfg);
      const id1 = getIdentity(db, key, cfg)!;
      expect(id1.meta.milad_review).toBe("approved");
      expect(id1.meta.foo).toBe(42);
      setIdentityFields(db, key, { "meta.foo": null }, NOW, cfg);
      const id2 = getIdentity(db, key, cfg)!;
      expect(id2.meta.foo).toBeUndefined();
      expect(id2.meta.milad_review).toBe("approved"); // untouched
    } finally {
      cleanup();
    }
  });

  test("rejects an unknown field", () => {
    const { db, cfg, key, cleanup } = setup();
    try {
      expect(() => setIdentityFields(db, key, { garbage_field: "x" }, NOW, cfg)).toThrow(/unknown field/);
    } finally {
      cleanup();
    }
  });

  test("rejects mutating cluster/role/identity_key", () => {
    const { db, cfg, key, cleanup } = setup();
    try {
      expect(() => setIdentityFields(db, key, { cluster: "other" }, NOW, cfg)).toThrow(/immutable/);
    } finally {
      cleanup();
    }
  });

  test("rejects per-role writes on a core identity", () => {
    const { db, cfg, cleanup } = setup();
    try {
      const key = "pr-watch:concierge";
      mintIdentity(db, key, { cluster: "pr-watch", role: "concierge" }, NOW);
      expect(() => setIdentityFields(db, key, { pr_number: 1 }, NOW, cfg)).toThrow();
    } finally {
      cleanup();
    }
  });
});

describe("lifecycle + scratch dir + sessions link", () => {
  test("complete + archive flags on identities", () => {
    const db = openCatalogue(":memory:");
    const key = "pr-watch:pr-agent:owner/repo#12345";
    mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    completeIdentity(db, key, NOW);
    expect(getIdentity(db, key)!.completed).toBe(true);
    archiveIdentity(db, key, NOW);
    expect(getIdentity(db, key)!.archived).toBe(true);
  });

  test("identityScratchDir path is deterministic; ensureScratchDir creates it", () => {
    const runtime = mkdtempSync(join(tmpdir(), "id-run-"));
    try {
      const key = "pr-watch:pr-agent:owner/repo#12345";
      const dir = identityScratchDir(key, runtime);
      expect(dir).toBe(join(runtime, "clusters", "pr-watch", "identities", "pr-agent", "owner_repo#12345"));
      const created = ensureScratchDir(key, runtime);
      const { existsSync } = require("node:fs");
      expect(existsSync(created)).toBe(true);
    } finally {
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  test("sessionsForIdentity returns catalogue rows linked to this key", () => {
    const db = openCatalogue(":memory:");
    const key = "pr-watch:pr-agent:owner/repo#12345";
    mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    db.query(
      `INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ('s1', $k, $now), ('s2', $k, $now)`,
    ).run({ $k: key, $now: NOW });
    expect(sessionsForIdentity(db, key)).toEqual(["s1", "s2"]);
  });
});

describe("listIdentities filters", () => {
  test("filter by cluster, role, kind, grouping, completed, archived", () => {
    const db = openCatalogue(":memory:");
    mintIdentity(db, "c1:pr-agent:x#1", { cluster: "c1", role: "pr-agent", groupingId: "g1" }, NOW);
    mintIdentity(db, "c1:pr-agent:x#2", { cluster: "c1", role: "pr-agent", groupingId: "g2" }, NOW);
    mintIdentity(db, "c2:pr-agent:y#1", { cluster: "c2", role: "pr-agent" }, NOW);
    mintIdentity(db, "c1:concierge", { cluster: "c1", role: "concierge" }, NOW);
    completeIdentity(db, "c1:pr-agent:x#1", NOW);

    expect(listIdentities(db, { cluster: "c1" }).length).toBe(3);
    expect(listIdentities(db, { cluster: "c1", role: "pr-agent" }).length).toBe(2);
    expect(listIdentities(db, { kind: "core" }).length).toBe(1);
    expect(listIdentities(db, { kind: "fleet" }).length).toBe(3);
    expect(listIdentities(db, { groupingId: "g1" }).length).toBe(1);
    expect(listIdentities(db, { completed: true }).length).toBe(1);
  });
});

describe("mark mirror does NOT cascade lifecycle onto CORE identities", () => {
  // Regression from live TUI: archiving one control session flipped `pr-watch:control`
  // to archived, which cascaded to hiding every peer session attached to that same core
  // identity. Core identities span many session lifetimes — session-level archive must
  // stay per-session for them. Fleet identities remain 1:1 with a work unit, so mirroring
  // there is still desirable.
  test("session lifecycle write against a CORE identity does not flip the identity", () => {
    const db = openCatalogue(":memory:");
    const key = "pr-watch:control";
    mintIdentity(db, key, { cluster: "pr-watch", role: "control" }, NOW);
    db.query("INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)")
      .run({ $sid: "s1", $k: key, $now: NOW });

    // Simulate the mark path's mirror decision (from commands.ts). For CORE identities,
    // lifecycle keys (`archived`, `completed`, `parked_task_id`) must be filtered OUT
    // before calling setIdentityFields — so the identity's flags stay put.
    const kind = (db.query("SELECT kind FROM identities WHERE identity_key = $k").get({ $k: key }) as
      { kind: string }).kind;
    const patch: Record<string, unknown> = { archived: true };
    const routed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "status_line" || k === "stage" || k === "grouping_id" || k.startsWith("meta.")) {
        routed[k] = v;
      } else if (k === "completed" || k === "archived" || k === "parked_task_id") {
        if (kind !== "core") routed[k] = v;
      }
    }
    expect(routed).toEqual({}); // for a core identity, an `archived` mirror is filtered out
    // sanity: the identity stays active
    expect(getIdentity(db, key)!.archived).toBe(false);
  });

  test("session lifecycle write against a FLEET identity still mirrors (retire cascade)", () => {
    const db = openCatalogue(":memory:");
    const key = "pr-watch:pr-agent:owner/repo#42";
    mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    const kind = (db.query("SELECT kind FROM identities WHERE identity_key = $k").get({ $k: key }) as
      { kind: string }).kind;
    expect(kind).toBe("fleet");
    const patch: Record<string, unknown> = { archived: true };
    const routed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === "completed" || k === "archived" || k === "parked_task_id") {
        if (kind !== "core") routed[k] = v;
      }
    }
    expect(routed.archived).toBe(true); // fleet: mirror flows through
  });

  // Regression / policy pin: `ccs identity archive <key>` then
  // `ccs session complete <sid>` on an attached fleet session must NOT
  // un-archive the identity. The concern (from the punch list): the mirror
  // path from mark() might route through `completeIdentity` (which resets
  // archived=0). It doesn't — it calls setIdentityFields which only writes
  // the columns explicitly in the patch. This test locks that in end-to-end.
  test("session complete after identity archive: archived stays 1, completed also lands", () => {
    const db = openCatalogue(":memory:");
    const key = "pr-watch:pr-agent:owner/repo#77";
    mintIdentity(db, key, { cluster: "pr-watch", role: "pr-agent" }, NOW);
    // Archive the identity first.
    archiveIdentity(db, key, NOW);
    expect(getIdentity(db, key)!.archived).toBe(true);

    // Attach a session and simulate the mark() mirror decision for
    // `session complete <sid>`. Only `completed` is in the mirror patch;
    // `archived` is NOT touched by session-level lifecycle writes.
    db.query("INSERT INTO catalogue (session_id, identity_key, updated_at) VALUES ($sid, $k, $now)")
      .run({ $sid: "s-complete-after-archive", $k: key, $now: NOW });
    setIdentityFields(db, key, { completed: true }, NOW);

    const id = getIdentity(db, key)!;
    expect(id.archived).toBe(true); // ← the critical assertion: still archived
    expect(id.completed).toBe(true); // completed flowed through as expected
  });
});
