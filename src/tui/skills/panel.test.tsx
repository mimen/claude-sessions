import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../../index/schema.ts";
import { openSkillsDb, saveSkills, setCategory } from "../../skills/db.ts";
import { loadConfig } from "../../config.ts";
import { SkillsPanel } from "./SkillsPanel.tsx";

test("skills panel renders seeded registry without discovery", async () => {
  const skillsDb = openSkillsDb(":memory:");
  const indexDb = openIndex(":memory:");
  saveSkills(skillsDb, [
    {
      name: "beeper",
      path: "/Users/mimen/.claude/skills/beeper",
      realPath: "/Users/mimen/.claude/skills/beeper",
      ecosystem: "claude-user",
      description: "Send messages",
      aliases: [],
      mtimeMs: 1,
      contentHash: "h1",
    },
    {
      name: "event-worker",
      path: "/Users/mimen/Documents/event-watch/skills/event-worker",
      realPath: "/Users/mimen/Documents/event-watch/skills/event-worker",
      ecosystem: "claude-project",
      description: "Per-event assistant",
      aliases: [],
      mtimeMs: 1,
      contentHash: "h2",
    },
  ]);
  setCategory(skillsDb, "beeper", "comms");

  const configResult = loadConfig("/nonexistent-ccs-test.toml");
  if (!configResult.ok) throw new Error("config load failed");
  const config = { ...configResult.value, store: { path: mkdtempSync(join(tmpdir(), "ccs-skills-test-")) } };

  const { lastFrame, unmount } = render(
    createElement(SkillsPanel, {
      skillsDb,
      indexDb,
      config,
      onSwitchMode: () => {},
      onShowSessions: () => {},
    }),
  );
  await new Promise((r) => setTimeout(r, 80));
  const frame = lastFrame() ?? "";
  expect(frame).toContain("SKILLS");
  expect(frame).toContain("beeper");
  // Narrow test terminal truncates long names — the section header proves the row is there.
  expect(frame).toContain("EVENT-WATCH · 1");
  expect(frame).toContain("comms");
  unmount();
  skillsDb.close();
  indexDb.close();
});
