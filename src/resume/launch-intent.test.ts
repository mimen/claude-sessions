import { describe, expect, test } from "bun:test";
import { parseOpts, resolveLaunchIntent, writeSessionMetadata, type NewSessionOpts } from "./new-session.ts";
import { getRow, openCatalogue } from "../catalogue/db.ts";

const PARENT = "11111111-1111-4111-8111-111111111111";

function parsedOpts(args: string[]): NewSessionOpts {
  const result = parseOpts(args);
  if (!result.ok) throw result.error;
  return result.value;
}

describe("new-session launch intent", () => {
  test("requires exactly one declaration before reservation", () => {
    expect(resolveLaunchIntent(parsedOpts([]), [])).toContain("exactly one");
    expect(resolveLaunchIntent(parsedOpts(["--top-level", "--child-of", PARENT]), ["--top-level", "--child-of", PARENT])).toContain("exactly one");
  });

  test("accepts dash-prefixed prompt values and equals-style flags", () => {
    const dashed = parsedOpts(["--top-level", "--prompt", "--focus API behavior"]);
    expect(dashed.prompt).toBe("--focus API behavior");
    const inline = parsedOpts(["--top-level", "--prompt=Review.", "--cwd=/tmp"]);
    expect(inline.prompt).toBe("Review.");
    expect(inline.cwd).toBe("/tmp");
  });

  test("marks top-level launches without a parent", () => {
    const opts = parsedOpts(["--top-level"]);
    expect(resolveLaunchIntent(opts, ["--top-level"])).toBeNull();
    expect(opts.parent).toBeUndefined();
  });

  test("resolves dot from the current session environment", () => {
    const prior = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_CODE_SESSION_ID = PARENT;
    try {
      const opts = parsedOpts(["--child-of", "."]);
      expect(resolveLaunchIntent(opts, ["--child-of", "."])).toBeNull();
      expect(opts.parent).toBe(PARENT);
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = prior;
    }
  });

  test("does not permit repair-only parent launch input", () => {
    const opts = parsedOpts(["--parent", PARENT, "--top-level"]);
    expect(resolveLaunchIntent(opts, ["--parent", PARENT, "--top-level"])).toContain("repair-only");
  });

  test("persists work_body and auxiliary class at birth", () => {
    const db = openCatalogue(":memory:");
    try {
      const top = parsedOpts(["--top-level"]);
      expect(resolveLaunchIntent(top, ["--top-level"])).toBeNull();
      writeSessionMetadata(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", top, "2026-07-20T00:00:00Z");
      expect(getRow(db, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")?.sessionClass).toBe("work_body");

      const child = parsedOpts(["--child-of", PARENT]);
      expect(resolveLaunchIntent(child, ["--child-of", PARENT])).toBeNull();
      writeSessionMetadata(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", child, "2026-07-20T00:00:00Z");
      const row = getRow(db, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(row?.sessionClass).toBe("auxiliary");
      expect(row?.parentSessionId).toBe(PARENT);
    } finally {
      db.close();
    }
  });
});
