import { test, expect } from "bun:test";
import { cleanLabel } from "./label.ts";

test("plain prose is kept and trimmed", () => {
  expect(cleanLabel(["Can you put together a report of the last 3 events?"])).toBe(
    "Can you put together a report of the last 3 events?",
  );
});

test("bare slash command surfaces as its name", () => {
  expect(cleanLabel(["/finance-session-startup"])).toBe("/finance-session-startup");
});

test("command stub wrapper surfaces the command name", () => {
  expect(
    cleanLabel(["<command-message>finance-session-startup</command-message>\n<command-name>/finance-session-startup</command-name>"]),
  ).toBe("/finance-session-startup");
});

test("leading pasted file path is stripped", () => {
  expect(cleanLabel(["/Users/you/Downloads/Artworks June 13\n\nAdd this event to the calendar"])).toBe(
    "Add this event to the calendar",
  );
});

test("local-command-caveat wrapper is skipped in favour of the next real text", () => {
  expect(
    cleanLabel(["<local-command-caveat>noise here</local-command-caveat>", "Actual question?"]),
  ).toBe("Actual question?");
});

test("long text is truncated with an ellipsis", () => {
  const out = cleanLabel(["x".repeat(200)]);
  expect(out.length).toBe(80);
  expect(out.endsWith("…")).toBe(true);
});

test("nothing usable yields (untitled)", () => {
  expect(cleanLabel([])).toBe("(untitled)");
  expect(cleanLabel(["<command-message></command-message>"])).toBe("(untitled)");
});
