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
function withSilentStderr<T>(fn: () => T): T {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
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
      const rc = withSilentStderr(() =>
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
      const rc = withSilentStderr(() =>
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
      const rc = identityCommand(["set", "pr-watch:concierge", "--meta.freeform=hello"]);
      expect(rc).toBe(0);
    });
  });
});
