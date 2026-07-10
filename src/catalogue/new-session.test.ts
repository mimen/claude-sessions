import { expect, test } from "bun:test";
import { openCatalogue, getRow, lifecycleOf, identityKeyOf } from "./db.ts";
import { parseOpts, writeSessionMetadata } from "./new-session.ts";

const NOW = "2026-07-08T00:00:00.000Z";

test("parseOpts: reads every flag, --role and --skill are synonyms", () => {
  const o = parseOpts([
    "--system", "pr-watch",
    "--role", "pr-agent",
    "--kind", "loop",
    "--phase", "building",
    "--project", "metered-pricing",
    "--key", "heroku_dashboard-12080",
    "--title", "#12080 Fix navbar",
    "--parent", "aaaa",
    "--cwd", "/tmp",
    "--prompt", "go build it",
    "--permission-mode", "acceptEdits",
    "--print-id",
  ]);
  expect(o.system).toBe("pr-watch");
  expect(o.role).toBe("pr-agent");
  expect(o.kind).toBe("loop");
  expect(o.phase).toBe("building");
  expect(o.project).toBe("metered-pricing");
  expect(o.key).toBe("heroku_dashboard-12080");
  expect(o.title).toBe("#12080 Fix navbar");
  expect(o.parent).toBe("aaaa");
  expect(o.cwd).toBe("/tmp");
  expect(o.prompt).toBe("go build it");
  expect(o.permissionMode).toBe("acceptEdits");
  expect(o.printId).toBe(true);
});

test("parseOpts: --skill is accepted as an alias for --role", () => {
  expect(parseOpts(["--skill", "pr-watch-eval"]).role).toBe("pr-watch-eval");
});

test("parseOpts: an unknown kind is left undefined (not coerced)", () => {
  expect(parseOpts(["--kind", "banana"]).kind).toBeUndefined();
});

test("writeSessionMetadata: binds identity to a not-yet-indexed id (forward reference)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "11111111-2222-3333-4444-555555555555";
    writeSessionMetadata(db, id, parseOpts([
      "--system", "pr-watch",
      "--role", "pr-agent",
      "--kind", "loop",
      "--phase", "building",
      "--key", "heroku_dashboard-12080",
      "--title", "#12080 Fix navbar",
    ]), NOW);

    const row = getRow(db, id);
    expect(row).not.toBeNull();
    expect(row!.system).toBe("pr-watch");
    expect(row!.role).toBe("pr-agent"); // canonical role axis (ADR-0015)
    expect(row!.skill).toBe("pr-agent"); // legacy mirror still written during migration
    expect(row!.kind).toBe("loop");
    expect(row!.phase).toBe("building");
    expect(identityKeyOf(row)).toBe("heroku_dashboard-12080");
    expect(row!.customTitle).toBe("#12080 Fix navbar");
    // The id is recorded as its own resume handle, so `ccs resume` can revive it pre-index.
    expect(row!.resumeId).toBe(id);
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: a leading slash on the role is normalised away", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    writeSessionMetadata(db, id, parseOpts(["--role", "/pr-watch-control"]), NOW);
    expect(getRow(db, id)!.role).toBe("pr-watch-control");
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: --resume-command is stored for a loop (comes back running)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "ffffffff-0000-1111-2222-333333333333";
    writeSessionMetadata(
      db,
      id,
      parseOpts(["--role", "control", "--resume-command", "/loop 15m /pr-watch-control"]),
      NOW,
    );
    expect(getRow(db, id)!.resumeCommand).toBe("/loop 15m /pr-watch-control");
  } finally {
    db.close();
  }
});

test("writeSessionMetadata: only the provided fields are written (no clobber to defaults)", () => {
  const db = openCatalogue(":memory:");
  try {
    const id = "99999999-8888-7777-6666-555555555555";
    writeSessionMetadata(db, id, parseOpts(["--system", "pr-watch"]), NOW);
    const row = getRow(db, id)!;
    expect(row.system).toBe("pr-watch");
    expect(row.phase).toBeNull();
    expect(row.customTitle).toBeNull();
    expect(row.skill).toBeNull();
    // A bare new session is idle by default (nothing set completed/archived/parked).
    expect(lifecycleOf(row)).toBe("idle");
  } finally {
    db.close();
  }
});
