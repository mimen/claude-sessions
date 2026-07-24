import { expect, test } from "bun:test";
import { identityRowLabel } from "./format.ts";

test("Event Watch core identities omit the redundant key annotation", () => {
  expect(identityRowLabel("event-watch:coordinator")).toBeNull();
  expect(identityRowLabel("event-watch:scout")).toBeNull();
  expect(identityRowLabel("event-watch:eval")).toBeNull();
});

test("Event Watch worker identities render a humanized work reference", () => {
  expect(identityRowLabel("event-watch:event-worker:gio-lucca-3oz-august"))
    .toBe("Gio Lucca 3oz August");
  expect(identityRowLabel("event-watch:event-worker:umbrella-weekend-2027"))
    .toBe("Umbrella Weekend 2027");
});

test("other clusters retain their full identity key", () => {
  expect(identityRowLabel("pr-watch:pr-agent:owner/repo#123")).toBe("pr-watch:pr-agent:owner/repo#123");
  expect(identityRowLabel(null)).toBeNull();
});
