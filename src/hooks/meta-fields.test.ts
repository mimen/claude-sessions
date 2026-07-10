import { expect, test } from "bun:test";
import { classifyFields, metaField, META_FIELDS } from "./meta-fields.ts";

test("classifyFields splits known from unknown", () => {
  const { known, unknown } = classifyFields(["updated_at", "pr_state", "bogus"]);
  expect(known.map((k) => k.field)).toEqual(["updated_at", "pr_state"]);
  expect(unknown).toEqual(["bogus"]);
});

test("every known field declares a source and a note", () => {
  for (const m of Object.values(META_FIELDS)) {
    expect(m.source).toBeTruthy();
    expect(m.note.length).toBeGreaterThan(0);
  }
});

test("updated_at is the one timestamp-sourced field (the heartbeat)", () => {
  expect(metaField("updated_at")?.source).toBe("timestamp");
  const timestamps = Object.values(META_FIELDS).filter((m) => m.source === "timestamp");
  expect(timestamps.map((m) => m.field)).toEqual(["updated_at"]);
});

test("result/judgment are artifact-sourced identity-state docs (not columns)", () => {
  expect(metaField("result")?.source).toBe("artifact");
  expect(metaField("result")?.column).toBe(false);
  expect(metaField("pr_state")?.column).toBe(true);
});

test("an unknown field resolves to null", () => {
  expect(metaField("nope")).toBeNull();
});
