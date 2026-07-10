import { expect, test } from "bun:test";
import {
  openCatalogue,
  getRow,
  setRole,
  setResumeCommand,
  setSkill,
} from "./db.ts";

const NOW = "2026-07-09T00:00:00Z";

test("role is a first-class column, set + round-trips", () => {
  const db = openCatalogue(":memory:");
  setRole(db, "s1", "pr-agent", NOW);
  expect(getRow(db, "s1")!.role).toBe("pr-agent");
});

test("resume_command is stored + round-trips (loops come back running, ADR-0015)", () => {
  const db = openCatalogue(":memory:");
  setResumeCommand(db, "ctrl", "/loop 15m /pr-watch-control", NOW);
  expect(getRow(db, "ctrl")!.resumeCommand).toBe("/loop 15m /pr-watch-control");
});

test("role falls back to legacy skill on read when role is unset (migration safety)", () => {
  const db = openCatalogue(":memory:");
  // a pre-migration row that only has `skill` set
  setSkill(db, "old", "pr-watch-eval", NOW);
  expect(getRow(db, "old")!.role).toBe("pr-watch-eval");
});

test("an explicit role wins over a legacy skill", () => {
  const db = openCatalogue(":memory:");
  setSkill(db, "s", "legacy-skill", NOW);
  setRole(db, "s", "concierge", NOW);
  expect(getRow(db, "s")!.role).toBe("concierge");
});

test("clearing role falls back to skill again", () => {
  const db = openCatalogue(":memory:");
  setSkill(db, "s", "sk", NOW);
  setRole(db, "s", "r", NOW);
  setRole(db, "s", null, NOW);
  expect(getRow(db, "s")!.role).toBe("sk");
});
