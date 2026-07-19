import { describe, expect, test } from "bun:test";
import { classifyMetaArgs } from "./cli.ts";

// Locks in the fix for the silent no-op bug where `ccs meta . <key> <value>` used to run the READ
// command with args[2]/args[3] dropped. Real regression: 2026-07-13, a full day of concierge
// "record milad_review = approved" writes never landed and no error surfaced. Every shape the help
// text advertises must resolve to a concrete { read | set | error } routing decision.

describe("classifyMetaArgs — READ shapes", () => {
  test("no args → read current session", () => {
    expect(classifyMetaArgs([])).toEqual({ mode: "read", id: undefined });
  });
  test("one arg (id) → read that session", () => {
    const r = classifyMetaArgs(["abc12345-6789-4def-8123-456789abcdef"]);
    expect(r.mode).toBe("read");
    if (r.mode !== "read") throw new Error();
    expect(r.id).toBe("abc12345-6789-4def-8123-456789abcdef");
  });
  test("one arg (.) → read current session", () => {
    expect(classifyMetaArgs(["."])).toEqual({ mode: "read", id: "." });
  });
});

describe("classifyMetaArgs — SET shapes (the pr-agent-typed shapes must all work)", () => {
  test("<id> <key> <value> → set on that session", () => {
    const r = classifyMetaArgs(["abc12345", "milad_review", "approved"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe("abc12345");
    expect(r.key).toBe("milad_review");
    expect(r.value).toBe("approved");
  });
  test(". <key> <value> → set on current session (the exact form pr-agent tried!)", () => {
    const r = classifyMetaArgs([".", "milad_review", "approved"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe(".");
    expect(r.key).toBe("milad_review");
    expect(r.value).toBe("approved");
  });
  test("<key> <value> without id → set on current session (implicit id=`.`)", () => {
    const r = classifyMetaArgs(["milad_review", "approved"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe(".");
    expect(r.key).toBe("milad_review");
    expect(r.value).toBe("approved");
  });
  test("full uuid + key + value works", () => {
    const r = classifyMetaArgs(["c3f409a0-e361-41e4-ab33-a580d8549576", "milad_review", "approved"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe("c3f409a0-e361-41e4-ab33-a580d8549576");
  });
});

describe("classifyMetaArgs — CLEAR shapes", () => {
  test("<id> <key> --off → clear", () => {
    const r = classifyMetaArgs(["abc12345", "milad_review", "--off"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe("abc12345");
    expect(r.key).toBe("milad_review");
    expect(r.value).toBeUndefined();
    expect(r.flags).toContain("--off");
  });
  test("<key> --off → clear on current session", () => {
    const r = classifyMetaArgs(["milad_review", "--off"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe(".");
    expect(r.key).toBe("milad_review");
  });
  test(". <key> --off → clear on current session", () => {
    const r = classifyMetaArgs([".", "milad_review", "--off"]);
    expect(r.mode).toBe("set");
    if (r.mode !== "set") throw new Error();
    expect(r.id).toBe(".");
    expect(r.key).toBe("milad_review");
  });
});

describe("classifyMetaArgs — ERROR shapes (the silent-no-op prevention net)", () => {
  test("<id-hint> <key> WITHOUT value → error (would silently drop before the fix)", () => {
    // pr-agent literally hit this: `ccs meta c3f409a0-... milad_review` (no value) — used to hit
    // the READ path which ignores args[2], now must error loudly.
    const r = classifyMetaArgs(["c3f409a0-e361-41e4-ab33-a580d8549576", "milad_review"]);
    expect(r.mode).toBe("error");
    if (r.mode !== "error") throw new Error();
    expect(r.message).toContain("value required");
  });
  test("--off with no positionals → error", () => {
    const r = classifyMetaArgs(["--off"]);
    expect(r.mode).toBe("error");
  });
  test(">=3 positionals with a non-id first arg → error (probably meant `key value extra`)", () => {
    const r = classifyMetaArgs(["not_an_id", "milad_review", "approved"]);
    expect(r.mode).toBe("error");
  });
  test("--off with a non-id first arg (looks like a key, not clear which) → error", () => {
    // `ccs meta not_an_id --off` is ambiguous: is `not_an_id` the id or the key? Reject to force
    // explicit `.` or a real id.
    const r = classifyMetaArgs(["not_an_id", "some_key", "--off"]);
    expect(r.mode).toBe("error");
  });
});
