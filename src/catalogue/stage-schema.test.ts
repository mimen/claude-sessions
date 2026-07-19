import { expect, test } from "bun:test";
import { validateStageTransition } from "./stage-schema.ts";
import type { StageSchema } from "./db.ts";

const PR: StageSchema = {
  values: ["building", "milad-review", "in-review", "approved", "merged"],
  monotonic: true,
};

test("null schema is unconstrained — any value allowed", () => {
  expect(validateStageTransition(null, "merged", "building")).toBeNull();
});

test("empty values is unconstrained", () => {
  expect(validateStageTransition({ values: [], monotonic: true }, "x", "y")).toBeNull();
});

test("a value outside the vocabulary is refused", () => {
  const err = validateStageTransition(PR, null, "shipping");
  expect(err).toContain("not allowed");
  expect(err).toContain("building | milad-review");
});

test("an in-vocabulary forward move is allowed", () => {
  expect(validateStageTransition(PR, "building", "in-review")).toBeNull();
  expect(validateStageTransition(PR, "building", "building")).toBeNull(); // equal rank ok
});

test("monotonic refuses a backward move", () => {
  const err = validateStageTransition(PR, "merged", "building");
  expect(err).toContain("monotonic");
  expect(err).toContain("merged→building");
});

test("a non-monotonic schema allows backward moves within the vocabulary", () => {
  const free: StageSchema = { values: ["a", "b", "c"], monotonic: false };
  expect(validateStageTransition(free, "c", "a")).toBeNull();
});

test("an unranked current value doesn't block a valid forward set", () => {
  // current isn't in the vocabulary (e.g. vocabulary changed under an old row) → only the new
  // value is validated; monotonic can't compare, so it's allowed.
  expect(validateStageTransition(PR, "legacy-phase", "in-review")).toBeNull();
});

test("first set (no current stage) just checks vocabulary", () => {
  expect(validateStageTransition(PR, null, "building")).toBeNull();
});
