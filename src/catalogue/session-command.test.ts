import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  getRow,
  openCatalogue,
  setCreatorKind,
  setCreatorRef,
  setLaunchChannel,
  setParent,
  setSessionClass,
} from "./db.ts";
import { openIndex } from "../index/schema.ts";
import { mintIdentity } from "./identities.ts";
import { sessionCommand } from "./session-command.ts";

const NOW = "2026-07-14T12:00:00Z";

/** Set up a fresh CCS_ROOT-scoped catalogue at a tmp dir. */
async function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccs-sess-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  try {
    await fn(root);
  } finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Seed one identity + one session in the DB. */
function seedSession(root: string, sid: string, identityKey?: string): void {
  mkdirSync(join(root, "cache"), { recursive: true });
  const dbPath = join(root, "cache", "catalogue.db");
  const db = openCatalogue(dbPath);
  if (identityKey) {
    mintIdentity(db, identityKey, { cluster: "pr-watch", role: "pr-agent" }, NOW);
  }
  db.query(
    `INSERT INTO catalogue (session_id, identity_key, custom_title, updated_at)
     VALUES ($sid, $k, 'seed title', $now)`,
  ).run({ $sid: sid, $k: identityKey ?? null, $now: NOW });
  db.close();
}

function seedIndexedSession(root: string, sid: string, resumeId = "resume-id"): void {
  mkdirSync(join(root, "cache"), { recursive: true });
  const db = openIndex(join(root, "cache", "index.db"));
  db.query(
    `INSERT INTO sessions (
      session_id, host, path, cwd, project_root, project_name, fallback_label,
      msg_count, file_mtime, file_size, skeleton, resume_id
    ) VALUES ($sid, 'host', '/tmp/transcript.jsonl', '/tmp/project', '/tmp/project', 'project',
      'indexed transcript', 1, 1, 1, '', $resume)`,
  ).run({ $sid: sid, $resume: resumeId });
  db.close();
}

describe("session shim-register", () => {
  test("creates a human work body with shim provenance", async () => {
    await withRoot(async (root) => {
      const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      expect(await sessionCommand([
        "shim-register",
        `--session-id=${sessionId}`,
        "--cwd=/tmp/project",
      ])).toBe(0);

      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      try {
        expect(getRow(db, sessionId)).toMatchObject({
          resumeId: sessionId,
          sessionClass: "work_body",
          creatorKind: "human",
          creatorRef: null,
          launchChannel: "claude_shim",
          meta: { launch_cwd: "/tmp/project" },
        });
      } finally {
        db.close();
      }
    });
  });

  test("verifies a human-created supporting child without requiring a creator ref", async () => {
    await withRoot(async (root) => {
      const parent = "11111111-1111-4111-8111-111111111111";
      const child = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      mkdirSync(join(root, "cache"), { recursive: true });
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      setSessionClass(db, child, "auxiliary", NOW);
      setCreatorKind(db, child, "human", NOW);
      setLaunchChannel(db, child, "ccs_session_new", NOW);
      setParent(db, child, parent, NOW);
      db.close();

      const priorKind = process.env.CCS_LAUNCH_CREATOR_KIND;
      const priorRef = process.env.CCS_LAUNCH_CREATOR_REF;
      process.env.CCS_LAUNCH_CREATOR_KIND = "human";
      delete process.env.CCS_LAUNCH_CREATOR_REF;
      try {
        expect(await sessionCommand([
          "shim-register",
          `--session-id=${child}`,
          "--require-existing",
          `--parent-session-id=${parent}`,
        ])).toBe(0);
      } finally {
        priorKind === undefined ? delete process.env.CCS_LAUNCH_CREATOR_KIND : (process.env.CCS_LAUNCH_CREATOR_KIND = priorKind);
        priorRef === undefined ? delete process.env.CCS_LAUNCH_CREATOR_REF : (process.env.CCS_LAUNCH_CREATOR_REF = priorRef);
      }
    });
  });

  test("verifies automation creator independently from causal parent", async () => {
    await withRoot(async (root) => {
      const parent = "11111111-1111-4111-8111-111111111111";
      const child = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      mkdirSync(join(root, "cache"), { recursive: true });
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      setSessionClass(db, child, "auxiliary", NOW);
      setCreatorKind(db, child, "automation", NOW);
      setCreatorRef(db, child, "imsg-server", NOW);
      setLaunchChannel(db, child, "ccs_delegate", NOW);
      setParent(db, child, parent, NOW);
      db.close();

      const priorPublicKind = process.env.CCS_CREATOR_KIND;
      const priorPublicRef = process.env.CCS_CREATOR_REF;
      const priorLaunchKind = process.env.CCS_LAUNCH_CREATOR_KIND;
      const priorLaunchRef = process.env.CCS_LAUNCH_CREATOR_REF;
      delete process.env.CCS_CREATOR_KIND;
      delete process.env.CCS_CREATOR_REF;
      process.env.CCS_LAUNCH_CREATOR_KIND = "automation";
      process.env.CCS_LAUNCH_CREATOR_REF = "imsg-server";
      try {
        expect(await sessionCommand([
          "shim-register",
          `--session-id=${child}`,
          "--require-existing",
          `--parent-session-id=${parent}`,
        ])).toBe(0);
        process.env.CCS_LAUNCH_CREATOR_REF = "other-daemon";
        expect(await sessionCommand([
          "shim-register",
          `--session-id=${child}`,
          "--require-existing",
          `--parent-session-id=${parent}`,
        ])).toBe(4);
      } finally {
        priorPublicKind === undefined ? delete process.env.CCS_CREATOR_KIND : (process.env.CCS_CREATOR_KIND = priorPublicKind);
        priorPublicRef === undefined ? delete process.env.CCS_CREATOR_REF : (process.env.CCS_CREATOR_REF = priorPublicRef);
        priorLaunchKind === undefined ? delete process.env.CCS_LAUNCH_CREATOR_KIND : (process.env.CCS_LAUNCH_CREATOR_KIND = priorLaunchKind);
        priorLaunchRef === undefined ? delete process.env.CCS_LAUNCH_CREATOR_REF : (process.env.CCS_LAUNCH_CREATOR_REF = priorLaunchRef);
      }
    });
  });
});

describe("session read", () => {
  test("bare id → shows session + linked identity", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-1", "pr-watch:pr-agent:owner/repo#12345");
      const rc = await sessionCommand(["sess-1", "--json"]);
      expect(rc).toBe(0);
    });
  });

  test("missing session errors", async () => {
    await withRoot(async () => {
      const rc = await sessionCommand(["does-not-exist"]);
      expect(rc).toBe(1);
    });
  });
});

describe("session set", () => {
  test("--identity= attaches the session to an identity", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-2");
      // Mint an identity first — session set doesn't create it.
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, "pr-watch:pr-agent:x#1", { cluster: "pr-watch", role: "pr-agent" }, NOW);
      db.close();
      const rc = await sessionCommand(["set", "sess-2", "--identity=pr-watch:pr-agent:x#1"]);
      expect(rc).toBe(0);
      const check = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = check.query("SELECT identity_key FROM catalogue WHERE session_id = 'sess-2'").get() as {
        identity_key: string;
      };
      expect(row.identity_key).toBe("pr-watch:pr-agent:x#1");
      check.close();
    });
  });

  test("--identity= rejects a target whose cluster or role conflicts with an attached session", async () => {
    await withRoot(async (root) => {
      const sid = "sess-identity-conflict";
      const source = "event-watch:event-worker:gio";
      const target = "event-watch:other-role:gio";
      seedSession(root, sid, source);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, target, { cluster: "event-watch", role: "other-role" }, NOW);
      db.close();

      const rc = await sessionCommand(["set", sid, `--identity=${target}`]);
      expect(rc).toBe(1);
      const check = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = check.query("SELECT identity_key FROM catalogue WHERE session_id = $sid").get({ $sid: sid }) as {
        identity_key: string | null;
      };
      expect(row.identity_key).toBe(source);
      check.close();
    });
  });

  test("--identity= repairs a session whose previous identity is missing", async () => {
    await withRoot(async (root) => {
      const sid = "sess-dangling-identity";
      const stale = "event-watch:event-worker:gio";
      const replacement = "event-watch:event-worker:gio-fixed";
      seedSession(root, sid, stale);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      db.query("DELETE FROM identities WHERE identity_key = $key").run({ $key: stale });
      mintIdentity(db, replacement, { cluster: "event-watch", role: "event-worker" }, NOW);
      db.close();

      expect(await sessionCommand(["set", sid, `--identity=${replacement}`])).toBe(0);
      const check = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = check.query("SELECT identity_key FROM catalogue WHERE session_id = $sid").get({ $sid: sid }) as {
        identity_key: string | null;
      };
      expect(row.identity_key).toBe(replacement);
      check.close();
    });
  });

  test("--identity= refuses an identity_key that hasn't been minted (no dangling FKs)", async () => {
    // Regression: `ccs session set <sid> --identity=<key>` used to blindly
    // write identity_key with no existence check, producing a dangling FK
    // that breaks joins in `catalogue export`, board composers, TUI, etc.
    await withRoot(async (root) => {
      seedSession(root, "sess-fk-1");
      // The identity is never minted — attempt to attach anyway.
      const rc = await sessionCommand([
        "set",
        "sess-fk-1",
        "--identity=pr-watch:pr-agent:owner/repo#never-minted",
      ]);
      expect(rc).toBe(1);
      // The write must not have landed — the row's identity_key stays null.
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db
        .query("SELECT identity_key FROM catalogue WHERE session_id = 'sess-fk-1'")
        .get() as { identity_key: string | null };
      expect(row.identity_key).toBeNull();
      db.close();
    });
  });

  test("--parent=<non-uuid> is rejected — likely wrong arg order or a title", async () => {
    // Regression: parent() at commands.ts checks SESSION_ID_RE so a bare
    // string that isn't a UUID (e.g. someone confusing --parent with --title)
    // must not be silently stored as an id.
    await withRoot(async (root) => {
      const uuid = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
      seedSession(root, uuid);
      const rc = await sessionCommand(["set", uuid, "--parent=not-a-uuid"]);
      expect(rc).toBe(1);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db
        .query("SELECT parent_session_id FROM catalogue WHERE session_id = $sid")
        .get({ $sid: uuid }) as { parent_session_id: string | null };
      expect(row.parent_session_id).toBeNull();
      db.close();
    });
  });

  test("--parent=<uuid-shaped but nonexistent> is accepted as a forward reference", async () => {
    // Intentional: forward references are allowed because a hook may see the
    // parent id before the parent session is indexed. parent() warns to stderr
    // (via console.warn) but stores the reference. This test pins that
    // policy so a future 'refuse all unknown parents' change has to explicitly
    // update the test.
    await withRoot(async (root) => {
      const child = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
      const orphanParent = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      seedSession(root, child);
      const rc = await sessionCommand(["set", child, `--parent=${orphanParent}`]);
      expect(rc).toBe(0);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db
        .query("SELECT parent_session_id FROM catalogue WHERE session_id = $sid")
        .get({ $sid: child }) as { parent_session_id: string | null };
      expect(row.parent_session_id).toBe(orphanParent);
      db.close();
    });
  });

  test("--parent=. resolves the current session id before UUID validation", async () => {
    await withRoot(async (root) => {
      const child = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
      const currentParent = "ffffffff-ffff-4fff-8fff-ffffffffffff";
      const previous = process.env.CLAUDE_CODE_SESSION_ID;
      seedSession(root, child);
      process.env.CLAUDE_CODE_SESSION_ID = currentParent;
      try {
        expect(await sessionCommand(["set", child, "--parent=."])).toBe(0);
      } finally {
        previous === undefined
          ? delete process.env.CLAUDE_CODE_SESSION_ID
          : (process.env.CLAUDE_CODE_SESSION_ID = previous);
      }
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT parent_session_id FROM catalogue WHERE session_id = $sid").get({ $sid: child }) as {
        parent_session_id: string | null;
      };
      expect(row.parent_session_id).toBe(currentParent);
      db.close();
    });
  });

  test("--parent=<self> is rejected — a session can't be its own parent", async () => {
    // Regression guarantee: the parent()-level check already rejects
    // self-parent, and `session set --parent=` routes through it, so this
    // pins the behavior end-to-end. Prevents cycles and infinite lineage
    // walks in the TUI / board composers.
    await withRoot(async (root) => {
      const uuid = "2ed1df23-e1d3-4381-b285-bad39a4f5c00";
      seedSession(root, uuid);
      const rc = await sessionCommand(["set", uuid, `--parent=${uuid}`]);
      expect(rc).toBe(1);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db
        .query("SELECT parent_session_id FROM catalogue WHERE session_id = $sid")
        .get({ $sid: uuid }) as { parent_session_id: string | null };
      expect(row.parent_session_id).toBeNull();
      db.close();
    });
  });

  test("--title updates custom_title", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-3");
      const rc = await sessionCommand(["set", "sess-3", "--title=new title"]);
      expect(rc).toBe(0);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT custom_title FROM catalogue WHERE session_id = 'sess-3'").get() as {
        custom_title: string;
      };
      expect(row.custom_title).toBe("new title");
      db.close();
    });
  });

  test("no flags → error", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-4");
      const rc = await sessionCommand(["set", "sess-4"]);
      expect(rc).toBe(1);
    });
  });
});

describe("session unset", () => {
  test("--identity clears the FK", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-5", "pr-watch:pr-agent:owner/repo#99");
      const rc = await sessionCommand(["unset", "sess-5", "--identity"]);
      expect(rc).toBe(0);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT identity_key FROM catalogue WHERE session_id = 'sess-5'").get() as {
        identity_key: string | null;
      };
      expect(row.identity_key).toBeNull();
      db.close();
    });
  });

  test("--title clears the custom title", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-6");
      await sessionCommand(["unset", "sess-6", "--title"]);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT custom_title FROM catalogue WHERE session_id = 'sess-6'").get() as {
        custom_title: string | null;
      };
      expect(row.custom_title).toBeNull();
      db.close();
    });
  });
});

describe("session title", () => {
  test("delegates to rename (custom_title write)", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-7");
      const rc = await sessionCommand(["title", "sess-7", "brand", "new", "name"]);
      expect(rc).toBe(0);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT custom_title FROM catalogue WHERE session_id = 'sess-7'").get() as {
        custom_title: string;
      };
      expect(row.custom_title).toBe("brand new name");
      db.close();
    });
  });
});

describe("session lifecycle", () => {
  test("complete flips the flag", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-8");
      const rc = await sessionCommand(["complete", "sess-8"]);
      expect(rc).toBe(0);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT completed FROM catalogue WHERE session_id = 'sess-8'").get() as {
        completed: number;
      };
      expect(row.completed).toBe(1);
      db.close();
    });
  });

  test("archive flips the flag", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-9");
      await sessionCommand(["archive", "sess-9"]);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db.query("SELECT archived FROM catalogue WHERE session_id = 'sess-9'").get() as {
        archived: number;
      };
      expect(row.archived).toBe(1);
      db.close();
    });
  });

  // Regression: `ccs session complete <bogus-id>` used to silently create an
  // empty phantom row via ensureRow(). It should refuse with a "no such session"
  // error and leave the catalogue untouched.
  test("complete on unknown id → error, no phantom row", async () => {
    await withRoot(async (root) => {
      // seed *some* row so the cache dir + DB exist, but not the id we'll target
      seedSession(root, "sess-real");
      const rc = await sessionCommand(["complete", "agent-does-not-exist"]);
      expect(rc).toBe(1);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db
        .query("SELECT session_id FROM catalogue WHERE session_id = 'agent-does-not-exist'")
        .get();
      expect(row).toBeNull();
      db.close();
    });
  });

  test("archive on unknown id → error, no phantom row", async () => {
    await withRoot(async (root) => {
      seedSession(root, "sess-real");
      const rc = await sessionCommand(["archive", "agent-does-not-exist"]);
      expect(rc).toBe(1);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      const row = db
        .query("SELECT session_id FROM catalogue WHERE session_id = 'agent-does-not-exist'")
        .get();
      expect(row).toBeNull();
      db.close();
    });
  });
});

describe("session help / errors", () => {
  test("empty args → usage error", async () => {
    await withRoot(async () => {
      const rc = await sessionCommand([]);
      expect(rc).toBe(1);
    });
  });
});


describe("indexed-unattached sessions and adoption", () => {
  test("read succeeds for an indexed but uncatalogued session without converting it", async () => {
    await withRoot(async (root) => {
      seedIndexedSession(root, "indexed-only");
      expect(await sessionCommand(["indexed-only", "--json"])).toBe(0);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      expect(db.query("SELECT session_id FROM catalogue WHERE session_id = 'indexed-only'").get()).toBeNull();
      db.close();
    });
  });

  test("adopt requires an index row and a pre-existing identity", async () => {
    await withRoot(async (root) => {
      const key = "event-watch:event-worker:gio";
      mkdirSync(join(root, "cache"), { recursive: true });
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
      db.close();
      expect(await sessionCommand(["adopt", "not-indexed", `--identity=${key}`])).toBe(1);
      seedIndexedSession(root, "indexed-only");
      expect(await sessionCommand(["adopt", "indexed-only", "--identity=missing"])).toBe(1);
      const check = openCatalogue(join(root, "cache", "catalogue.db"));
      expect(check.query("SELECT COUNT(*) AS count FROM catalogue").get()).toEqual({ count: 0 });
      check.close();
    });
  });

  test("adopt creates only minimal metadata and refuses a second adopter", async () => {
    await withRoot(async (root) => {
      const sid = "indexed-only";
      const key = "event-watch:event-worker:gio";
      seedIndexedSession(root, sid, "resume-from-index");
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
      db.close();
      expect(await sessionCommand(["adopt", sid, `--identity=${key}`])).toBe(0);
      expect(await sessionCommand(["adopt", sid, `--identity=${key}`])).toBe(1);
      const check = openCatalogue(join(root, "cache", "catalogue.db"));
      expect(check.query("SELECT identity_key, resume_id, custom_title, parent_session_id FROM catalogue WHERE session_id = $sid").get({ $sid: sid })).toEqual({
        identity_key: key,
        resume_id: "resume-from-index",
        custom_title: null,
        parent_session_id: null,
      });
      expect(check.query("SELECT COUNT(*) AS count FROM identities").get()).toEqual({ count: 1 });
      check.close();
    });
  });

  test("set refuses uncatalogued ids and rolls back every combined field on validation failure", async () => {
    await withRoot(async (root) => {
      const sid = "indexed-only";
      const key = "event-watch:event-worker:gio";
      seedIndexedSession(root, sid);
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, key, { cluster: "event-watch", role: "event-worker" }, NOW);
      db.close();
      expect(await sessionCommand(["set", sid, `--identity=${key}`, "--title=must-not-write"])).toBe(1);
      const afterUncatalogued = openCatalogue(join(root, "cache", "catalogue.db"));
      expect(afterUncatalogued.query("SELECT session_id FROM catalogue WHERE session_id = $sid").get({ $sid: sid })).toBeNull();
      afterUncatalogued.close();

      seedSession(root, "catalogued");
      expect(await sessionCommand(["set", "catalogued", "--title=must-not-write", "--parent=not-a-uuid"])).toBe(1);
      expect(await sessionCommand(["set", "catalogued", "--cluster=retired"])).toBe(1);
      expect(await sessionCommand(["title", sid, "must-not-create"])).toBe(1);
      expect(await sessionCommand(["unset", sid, "--parent"])).toBe(1);
      const check = openCatalogue(join(root, "cache", "catalogue.db"));
      expect(check.query("SELECT custom_title, parent_session_id FROM catalogue WHERE session_id = 'catalogued'").get()).toEqual({
        custom_title: "seed title",
        parent_session_id: null,
      });
      check.close();
    });
  });
});
