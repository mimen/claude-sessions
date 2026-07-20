import { test, expect } from "bun:test";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../../index/schema.ts";
import { openCatalogue } from "../../catalogue/db.ts";
import { openSkillsDb, saveSkills } from "../../skills/db.ts";
import { loadConfig } from "../../config.ts";
import { Root } from "../Root.tsx";
import type { ResumeCommand } from "../../resume/command.ts";

async function waitForFrame(lastFrame: () => string | undefined, includes: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if ((lastFrame() ?? "").includes(includes)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(lastFrame() ?? "").toContain(includes);
}

test("rapid Tab toggling between modes never crashes (serialized skills writes)", async () => {
  const db = openIndex(":memory:");
  const catalogue = openCatalogue(":memory:");
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
  const config = {
    ...cr.value,
    store: { path: store },
    // Keep the test focused on the injected cmux effects; synchronous inference PATH probes
    // are separately covered by the App tests and are not part of this remount regression.
    inference: {
      ...cr.value.inference,
      codex: { ...cr.value.inference.codex, binary: "ccs-test-no-codex" },
      claude: { ...cr.value.inference.claude, binary: "ccs-test-no-claude" },
    },
  };
  const resumeRequest: { current: ResumeCommand | null } = { current: null };
  const pending: Array<() => void> = [];
  const cmuxProbes = {
    reachable: () => new Promise<boolean>((resolve) => pending.push(() => resolve(false))),
    openSessionTitles: () => new Promise<Map<string, string>>((resolve) => pending.push(() => resolve(new Map()))),
  };

  const { lastFrame, stdin, unmount } = render(
    createElement(Root, { db, catalogue, skillsDb, config, resumeRequest, initialMode: "skills" as const, cmuxProbes }),
  );
  try {
    await waitForFrame(lastFrame, "⌖ claude");
    for (let i = 0; i < 8; i++) {
      stdin.write("\t");
      // The sessions panel's footer contains Tab; skills mode identifies itself with the compass.
      await waitForFrame(lastFrame, i % 2 === 0 ? "Tab" : "⌖ claude");
    }
    // Resolve effects belonging to both mounted and already-unmounted Apps. Cancellation must make
    // stale results harmless, while the still-mounted Skills panel remains responsive.
    for (const resolve of pending) resolve();
    await waitForFrame(lastFrame, "⌖ claude");
  } finally {
    unmount();
    // Ink runs passive-effect cleanup on the next task; let App cancel its deferred title drain
    // before closing the in-memory databases.
    await new Promise<void>((resolve) => setImmediate(resolve));
    catalogue.close();
    db.close();
    skillsDb.close();
  }
});
