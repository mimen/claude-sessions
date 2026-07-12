import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../../index/schema.ts";
import { openSkillsDb, saveSkills } from "../../skills/db.ts";
import { loadConfig } from "../../config.ts";
import { Root } from "../Root.tsx";
import type { Titler } from "../../titler/codex.ts";
import type { ResumeCommand } from "../../resume/command.ts";

const noopTitler: Titler = { available: () => false, async generate() { return null; } };

test("rapid Tab toggling between modes never crashes (serialized skills writes)", async () => {
  const db = openIndex(":memory:");
  const skillsDb = openSkillsDb(":memory:");
  saveSkills(skillsDb, [
    { name: "beeper", path: "/Users/mimen/.claude/skills/beeper", realPath: "/Users/mimen/.claude/skills/beeper", ecosystem: "claude-user", description: "", aliases: [], mtimeMs: 1, contentHash: "h" },
  ]);
  // A store with a real transcript so every skills remount kicks off a (serialized) mine.
  const store = mkdtempSync(join(tmpdir(), "ccs-tab-"));
  const line = JSON.stringify({ timestamp: "2026-07-07T00:00:00Z", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "beeper" } }] } });
  writeFileSync(join(store, "s1.jsonl"), (line + "\n").repeat(500));
  const cr = loadConfig("/nonexistent.toml");
  if (!cr.ok) throw new Error("cfg");
  const config = { ...cr.value, store: { path: store } };
  const resumeRequest: { current: ResumeCommand | null } = { current: null };

  const { lastFrame, stdin, unmount } = render(
    createElement(Root, { db, skillsDb, config, titler: noopTitler, resumeRequest, initialMode: "skills" as const }),
  );
  await new Promise((r) => setTimeout(r, 40));
  for (let i = 0; i < 8; i++) {
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 40));
  }
  await new Promise((r) => setTimeout(r, 250));
  // Ended on an even number of tabs → back in skills mode, still alive and rendering.
  expect(lastFrame() ?? "").toContain("⌖ claude");
  unmount();
  db.close();
  skillsDb.close();
});
