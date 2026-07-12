import { expect, test } from "bun:test";
import {
  openCatalogue,
  getRow,
  setRole,
  setResumeCommand,
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
