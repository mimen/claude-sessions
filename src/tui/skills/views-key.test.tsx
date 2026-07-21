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
  // The claude-@-cwd context lens shows the ACTUAL cwd in the summary line. When run from
  // a deep worktree, the summary line hits the ink-testing-library's 100-column stdout mock
  // and the "view <name>" token gets clipped by the right-flexbox label ("Tab sessions · ?").
  // Pin process.cwd() to a short path for the duration of this test so the width math is stable
  // regardless of where the test process actually runs. Restore in finally.
  const origCwd = process.cwd;
  process.cwd = () => "/x";
  try {
    const skillsDb = openSkillsDb(":memory:");
    const indexDb = openIndex(":memory:");
    saveSkills(skillsDb, [{ name: "beeper", path: "/Users/mimen/.claude/skills/beeper", realPath: "/Users/mimen/.claude/skills/beeper", ecosystem: "claude-user", description: "", aliases: [], mtimeMs: 1, contentHash: "h" }]);
    const cr = loadConfig("/nonexistent.toml");
    if (!cr.ok) throw new Error("cfg");
    const config = { ...cr.value, store: { path: mkdtempSync(join(tmpdir(), "ccs-gx-")) } };
    const { lastFrame, stdin, unmount } = render(createElement(SkillsPanel, { skillsDb, indexDb, config, onSwitchMode: () => {}, onShowSessions: () => {} }));
    await new Promise((r) => setTimeout(r, 60));
    stdin.write("x"); // -> claude @ ~
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain("view access");
    expect(lastFrame()).toContain("GLOBAL");
    stdin.write("g");
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain("view home");
    stdin.write("g"); stdin.write("g");
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain("view category");
    stdin.write("x"); // next context resets to access
    await new Promise((r) => setTimeout(r, 30));
    expect(lastFrame()).toContain("view access");
    unmount();
  } finally {
    process.cwd = origCwd;
  }
});
