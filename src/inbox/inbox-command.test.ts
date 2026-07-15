import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxCommand } from "./inbox-command.ts";

async function withRoot(fn: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ccs-inbox-cmd-"));
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

/** Capture stdout while fn runs; return combined output. */
function captureStdout<T>(fn: () => T): { rc: T; out: string } {
  const orig = console.log;
  let out = "";
  console.log = (...a: unknown[]) => {
    out += a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
  };
  try {
    const rc = fn();
    return { rc, out };
  } finally {
    console.log = orig;
  }
}

describe("ccs inbox drain — empty inbox", () => {
  test("drain <key> on an identity with 0 messages → exit 0 with count:0", async () => {
    // Punch-list guarantee: bogus/empty key produces a clean OK with an
    // empty messages array. No phantom rows, no crash on a fresh DB.
    await withRoot(async () => {
      const { rc, out } = captureStdout(() =>
        inboxCommand(["drain", "pr-watch:pr-agent:no/repo#never"]),
      );
      expect(rc).toBe(0);
      const parsed = JSON.parse(out.trim());
      expect(parsed.status).toBe("OK");
      expect(parsed.count).toBe(0);
      expect(parsed.messages).toEqual([]);
    });
  });
});
