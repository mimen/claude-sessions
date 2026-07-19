import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../../index/schema.ts";
import { openSkillsDb, saveSkills } from "../../skills/db.ts";
import { loadConfig } from "../../config.ts";
import { SkillsPanel } from "./SkillsPanel.tsx";

test("g cycles grouping views", async () => {
  const skillsDb = openSkillsDb(":memory:");
  const indexDb = openIndex(":memory:");
  saveSkills(skillsDb, [{ name: "beeper", path: "/x/.claude/skills/beeper", realPath: "/x/.claude/skills/beeper", ecosystem: "claude-user", description: "", aliases: [], mtimeMs: 1, contentHash: "h" }]);
  const cr = loadConfig("/nonexistent.toml");
  if (!cr.ok) throw new Error("cfg");
  const config = { ...cr.value, store: { path: mkdtempSync(join(tmpdir(), "ccs-g-")) } };
  const { lastFrame, stdin, unmount } = render(createElement(SkillsPanel, { skillsDb, indexDb, config, onSwitchMode: () => {}, onShowSessions: () => {} }));
  await new Promise((r) => setTimeout(r, 60));
  // Default landing: the claude @ ~ lens grouped by category.
  expect(lastFrame()).toContain("⌖ claude");
  expect(lastFrame()).toContain("view category");
  stdin.write("g");
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("view activity");
  stdin.write("g");
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("view flat");
  stdin.write("g");
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("view access");
  stdin.write("g");
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("view home");
  unmount();
});

test("g inside a context lens cycles access -> home -> ... -> category", async () => {
  const skillsDb = openSkillsDb(":memory:");
  const indexDb = openIndex(":memory:");
  saveSkills(skillsDb, [{ name: "beeper", path: "/Users/mimen/.claude/skills/beeper", realPath: "/Users/mimen/.claude/skills/beeper", ecosystem: "claude-user", description: "", aliases: [], mtimeMs: 1, contentHash: "h" }]);
  const cr = loadConfig("/nonexistent.toml");
  if (!cr.ok) throw new Error("cfg");
  const config = { ...cr.value, store: { path: mkdtempSync(join(tmpdir(), "ccs-gx-")) } };
  const { lastFrame, stdin, unmount } = render(createElement(SkillsPanel, { skillsDb, indexDb, config, onSwitchMode: () => {}, onShowSessions: () => {} }));
  await new Promise((r) => setTimeout(r, 60));
  // Inside a context lens the header carries the long ⌖ path, so the header's "view <x>"
  // label wraps across the 80-col boundary. Assert on the footer's short, stable
  // `group:<view>` token instead (same state, never wraps).
  stdin.write("x"); // -> claude @ ~
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("group:access");
  expect(lastFrame()).toContain("GLOBAL");
  stdin.write("g");
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("group:home");
  stdin.write("g"); stdin.write("g");
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("group:category");
  stdin.write("x"); // next context resets to access
  await new Promise((r) => setTimeout(r, 30));
  expect(lastFrame()).toContain("group:access");
  unmount();
});
