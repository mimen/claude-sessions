import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalogue } from "./db.ts";
import { mintIdentity } from "./identities.ts";
import { identityCommand } from "./identity-command.ts";

const NOW = "2026-07-14T12:00:00Z";

async function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccs-idcmd-"));
  const prev = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  mkdirSync(join(root, "cache"), { recursive: true });
  try {
    await fn(root);
  } finally {
    prev === undefined ? delete process.env.CCS_ROOT : (process.env.CCS_ROOT = prev);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Silence expected stderr output during error-path tests. */
async function withSilentStderr<T>(fn: () => T | Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

describe("ccs identity set — unknown field handling", () => {
  test("--unknown_field=x on a core identity → exit 1", async () => {
    await withRoot(async (root) => {
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, "pr-watch:concierge", { cluster: "pr-watch", role: "concierge" }, NOW);
      db.close();
      const rc = await withSilentStderr(() =>
        identityCommand(["set", "pr-watch:concierge", "--unknown_field=x"]),
      );
      expect(rc).toBe(1);
    });
  });

  test("--unknown_field=x on a fleet identity → exit 1", async () => {
    await withRoot(async (root) => {
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(
        db,
        "pr-watch:pr-agent:owner/repo#12345",
        { cluster: "pr-watch", role: "pr-agent" },
        NOW,
      );
      db.close();
      const rc = await withSilentStderr(() =>
        identityCommand(["set", "pr-watch:pr-agent:owner/repo#12345", "--unknown_field=x"]),
      );
      expect(rc).toBe(1);
    });
  });

  test("meta.<anything>=v is accepted (not treated as unknown)", async () => {
    await withRoot(async (root) => {
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, "pr-watch:concierge", { cluster: "pr-watch", role: "concierge" }, NOW);
      db.close();
      const rc = await identityCommand(["set", "pr-watch:concierge", "--meta.freeform=hello"]);
      expect(rc).toBe(0);
    });
  });
});

describe("ccs identity ls / list — both aliases work", () => {
  // The top-level `ccs --help` advertises `ccs identity ls`, but the noun's
  // dispatch only knew `list`. Users copying from the top-level help hit
  // "no identity 'ls'" (fell through to doRead). Now both work.
  test("`identity list` runs the list verb", async () => {
    await withRoot(async (root) => {
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, "pr-watch:pr-agent:o/r#1", { cluster: "pr-watch", role: "pr-agent" }, NOW);
      db.close();
      const rc = await identityCommand(["list", "--cluster=pr-watch"]);
      expect(rc).toBe(0);
    });
  });

  test("`identity ls` is an alias for `identity list` (matches the ccs --help wording)", async () => {
    await withRoot(async (root) => {
      const db = openCatalogue(join(root, "cache", "catalogue.db"));
      mintIdentity(db, "pr-watch:pr-agent:o/r#1", { cluster: "pr-watch", role: "pr-agent" }, NOW);
      db.close();
      const rc = await identityCommand(["ls", "--cluster=pr-watch"]);
      expect(rc).toBe(0);
    });
  });
});
