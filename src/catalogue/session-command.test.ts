import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { openCatalogue } from "./db.ts";
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
});

describe("session help / errors", () => {
  test("empty args → usage error", async () => {
    await withRoot(async () => {
      const rc = await sessionCommand([]);
      expect(rc).toBe(1);
    });
  });
});
