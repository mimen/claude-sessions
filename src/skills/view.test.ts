import { describe, expect, test } from "bun:test";
import { homeOf, activityOf, driftedNames, matchesQuery, buildSkillItems, type SkillRow } from "./view.ts";
import { archiveGuard } from "./archive.ts";
import type { SkillRecord } from "./scan.ts";

const HOME = "/Users/mimen";

function rec(over: Partial<SkillRecord>): SkillRecord {
  return {
    name: "x",
    path: `${HOME}/.claude/skills/x`,
    realPath: `${HOME}/.claude/skills/x`,
    ecosystem: "claude-user",
    description: "",
    aliases: [],
    mtimeMs: 0,
    contentHash: "h",
    ...over,
  };
}

function row(over: Omit<Partial<SkillRow>, "rec"> & { rec?: Partial<SkillRecord> }): SkillRow {
  return {
    rec: rec(over.rec ?? {}),
    home: over.home ?? "global",
    category: over.category ?? null,
    tags: over.tags ?? [],
    usage: over.usage ?? null,
    drift: over.drift ?? false,
  };
}

describe("homeOf", () => {
  test("global via runtime and vault source", () => {
    expect(homeOf(`${HOME}/.claude/skills/beeper`, HOME)).toBe("global");
    expect(homeOf(`${HOME}/Documents/milad-vault/ClaudeConfig/skills/beeper`, HOME)).toBe("global");
  });
  test("workspace name", () => {
    expect(homeOf(`${HOME}/Documents/milad-vault/Workspaces/Events/.claude/skills/event-prep`, HOME)).toBe("Events");
  });
  test("repo name from .claude and bare skills dirs", () => {
    expect(homeOf(`${HOME}/Programming/Repos/sldl-app-monorepo/.claude/skills/pr-loop`, HOME)).toBe("sldl-app-monorepo");
    expect(homeOf(`${HOME}/Documents/event-watch/skills/event-worker`, HOME)).toBe("event-watch");
  });
  test("plugin marketplace", () => {
    expect(homeOf(`${HOME}/.claude/plugins/marketplaces/superpowers/skills/brainstorming`, HOME)).toBe(
      "plugin:superpowers",
    );
  });
  test("tool homes", () => {
    expect(homeOf(`${HOME}/.codex/skills/.system/imagegen`, HOME)).toBe("codex");
    expect(homeOf(`${HOME}/.agents/skills/grill-me`, HOME)).toBe("agents");
  });
});

describe("activityOf", () => {
  const now = Date.parse("2026-07-06T00:00:00Z");
  test("recent usage is active", () => {
    expect(activityOf({ invocations: 1, commands: 0, reads: 0, lastUsed: "2026-07-01T00:00:00Z" }, now)).toBe("active");
  });
  test("old usage is dormant", () => {
    expect(activityOf({ invocations: 1, commands: 0, reads: 0, lastUsed: "2026-01-01T00:00:00Z" }, now)).toBe("dormant");
  });
  test("no usage is unobserved", () => {
    expect(activityOf(null, now)).toBe("unobserved");
  });
});

describe("driftedNames", () => {
  test("same hash = no drift; differing hash = drift; empty hashes ignored", () => {
    const records = [
      rec({ name: "a", path: "/1/a", contentHash: "h1" }),
      rec({ name: "a", path: "/2/a", contentHash: "h1" }),
      rec({ name: "b", path: "/1/b", contentHash: "h1" }),
      rec({ name: "b", path: "/2/b", contentHash: "h2" }),
      rec({ name: "c", path: "/1/c", contentHash: "" }),
      rec({ name: "c", path: "/2/c", contentHash: "h9" }),
    ];
    const d = driftedNames(records);
    expect(d.has("a")).toBe(false);
    expect(d.has("b")).toBe(true);
    expect(d.has("c")).toBe(false);
  });
});

describe("matchesQuery", () => {
  const r = row({ rec: { name: "beeper", description: "Send messages" }, category: "comms", tags: ["messaging"] });
  test("plain term matches name/description/path", () => {
    expect(matchesQuery(r, "beep")).toBe(true);
    expect(matchesQuery(r, "messages")).toBe(true);
    expect(matchesQuery(r, "zzz")).toBe(false);
  });
  test("#term matches category or tag exactly", () => {
    expect(matchesQuery(r, "#comms")).toBe(true);
    expect(matchesQuery(r, "#messaging")).toBe(true);
    expect(matchesQuery(r, "#comm")).toBe(false);
  });
});

describe("buildSkillItems", () => {
  const now = Date.parse("2026-07-06T00:00:00Z");
  const rows = [
    row({ rec: { name: "a", path: "/1/a" }, home: "global", usage: { invocations: 1, commands: 0, reads: 0, lastUsed: "2026-07-05T00:00:00Z" } }),
    row({ rec: { name: "b", path: "/1/b" }, home: "global" }),
    row({ rec: { name: "c", path: "/2/c" }, home: "event-watch", category: "loops" }),
  ];
  test("home view groups by home, biggest section first", () => {
    const items = buildSkillItems(rows, { view: "home", sort: "name", collapsed: new Set(), nowMs: now });
    expect(items[0]).toMatchObject({ kind: "section", key: "global", count: 2 });
    expect(items.filter((i) => i.kind === "section").length).toBe(2);
  });
  test("category view pins uncategorized last", () => {
    const items = buildSkillItems(rows, { view: "category", sort: "name", collapsed: new Set(), nowMs: now });
    const sections = items.filter((i) => i.kind === "section") as Array<{ key: string }>;
    expect(sections[sections.length - 1]!.key).toBe("uncategorized");
  });
  test("activity view fixed order + collapse hides rows", () => {
    const items = buildSkillItems(rows, { view: "activity", sort: "name", collapsed: new Set(["unobserved"]), nowMs: now });
    const keys = items.filter((i) => i.kind === "section").map((i) => (i as { key: string }).key);
    expect(keys).toEqual(["active", "unobserved"]);
    expect(items.filter((i) => i.kind === "skill").length).toBe(1);
  });
  test("flat view has no sections", () => {
    const items = buildSkillItems(rows, { view: "flat", sort: "usage", collapsed: new Set(), nowMs: now });
    expect(items.every((i) => i.kind === "skill")).toBe(true);
    expect((items[0] as { row: SkillRow }).row.rec.name).toBe("a");
  });
});

describe("archiveGuard", () => {
  test("protects other tools' installs", () => {
    expect(archiveGuard(rec({ ecosystem: "plugin" }))).toContain("plugin");
    expect(archiveGuard(rec({ ecosystem: "codex" }))).toContain("codex");
  });
  test("allows claude-user and refuses double-archive", () => {
    expect(archiveGuard(rec({}))).toBeNull();
    expect(archiveGuard(rec({ path: "/v/_archive/skills/x" }))).toBe("already archived");
  });
});

describe("isInLinkedWorktree", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const { isInLinkedWorktree } = require("./scan.ts") as typeof import("./scan.ts");

  test("main checkout (.git dir) is not a worktree; linked worktree (.git file) is", () => {
    const root = mkdtempSync(join(tmpdir(), "ccs-wt-"));
    const main = join(root, "main", ".claude", "skills", "x");
    mkdirSync(main, { recursive: true });
    mkdirSync(join(root, "main", ".git"), { recursive: true });
    const linked = join(root, "wt", ".claude", "skills", "x");
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(root, "wt", ".git"), "gitdir: /elsewhere\n");
    expect(isInLinkedWorktree(main)).toBe(false);
    expect(isInLinkedWorktree(linked)).toBe(true);
    expect(isInLinkedWorktree(join(root, "nowhere-special"))).toBe(false);
  });
});

describe("shadowDuplicatePaths", () => {
  const { shadowDuplicatePaths } = require("./view.ts") as typeof import("./view.ts");
  test("identical same-eco copies hide all but shortest path; different hashes stay", () => {
    const records = [
      rec({ name: "imessage", path: "/h/.hermes/skills/apple/imessage", realPath: "/1", ecosystem: "hermes", contentHash: "h1" }),
      rec({ name: "imessage", path: "/h/.hermes/hermes-agent/skills/apple/imessage", realPath: "/2", ecosystem: "hermes", contentHash: "h1" }),
      rec({ name: "grill-me", path: "/a", realPath: "/3", ecosystem: "agents", contentHash: "g1" }),
      rec({ name: "grill-me", path: "/b", realPath: "/4", ecosystem: "claude-user", contentHash: "g2" }),
    ];
    const hidden = shadowDuplicatePaths(records);
    expect(hidden.has("/h/.hermes/hermes-agent/skills/apple/imessage")).toBe(true);
    expect(hidden.has("/h/.hermes/skills/apple/imessage")).toBe(false);
    expect(hidden.size).toBe(1);
  });
});
