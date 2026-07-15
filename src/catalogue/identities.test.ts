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
