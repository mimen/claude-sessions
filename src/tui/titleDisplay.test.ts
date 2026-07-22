import { expect, test } from "bun:test";
import { stripSpinnerPrefix } from "./titleDisplay.ts";

test("stripSpinnerPrefix: removes captured spinner frames from real polluted titles", () => {
  // Verbatim from the catalogue's custom_title column — different rows captured different frames.
  expect(stripSpinnerPrefix("✳ Filter subagent session runs")).toBe("Filter subagent session runs");
  expect(stripSpinnerPrefix("✳ priority-shelf-redesign")).toBe("priority-shelf-redesign");
  expect(stripSpinnerPrefix("⠂ fix-ccs-startup-crash")).toBe("fix-ccs-startup-crash");
  expect(stripSpinnerPrefix("⠐ Set up T3 code fork with Expo")).toBe("Set up T3 code fork with Expo");
  expect(stripSpinnerPrefix("✳ Claude Code")).toBe("Claude Code");
});

test("stripSpinnerPrefix: leaves legitimate non-letter leads alone", () => {
  // A blanket "trim non-letters" would corrupt all of these — 2771 rows are `(untitled)`.
  expect(stripSpinnerPrefix("(untitled)")).toBe("(untitled)");
  expect(stripSpinnerPrefix("/loop")).toBe("/loop");
  expect(stripSpinnerPrefix("/Users/mimen/Programming/Repos/claude-sessions")).toBe(
    "/Users/mimen/Programming/Repos/claude-sessions",
  );
  expect(stripSpinnerPrefix("[wip] refactor")).toBe("[wip] refactor");
  expect(stripSpinnerPrefix("#12137 fix the thing")).toBe("#12137 fix the thing");
  expect(stripSpinnerPrefix("2026 planning")).toBe("2026 planning");
  expect(stripSpinnerPrefix("-- dashes")).toBe("-- dashes");
});

test("stripSpinnerPrefix: handles edge cases without producing an empty title", () => {
  expect(stripSpinnerPrefix("✳")).toBe("✳"); // spinner-only → unchanged, never blank
  expect(stripSpinnerPrefix("⠂⠐✳  spaced")).toBe("spaced"); // multiple frames + padding
  expect(stripSpinnerPrefix("")).toBe("");
  expect(stripSpinnerPrefix("no decoration here")).toBe("no decoration here");
  expect(stripSpinnerPrefix("mid ✳ sentence")).toBe("mid ✳ sentence"); // only LEADING is stripped
});
