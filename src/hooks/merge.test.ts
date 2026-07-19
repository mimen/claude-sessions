import { expect, test } from "bun:test";
import {
  mergeSections, renderSections, mergeSetUnion, mergeOrderedActions,
  pickMostSpecific, mergeGuards, mergeByKind, type Section,
} from "./merge.ts";

// ── sections (claude-md) ──────────────────────────────────────────────────────
test("sections: a new id from each level accumulates in first-seen order", () => {
  const out = mergeSections([
    { sections: [{ id: "identity", body: "you are ccs" }] },
    { sections: [{ id: "constitution", body: "push != post" }] },
    { sections: [{ id: "role-brief", body: "own one PR" }] },
  ]);
  expect(out.map((s) => s.id)).toEqual(["identity", "constitution", "role-brief"]);
});

test("sections: default op appends bodies for the same id", () => {
  const out = mergeSections([
    { sections: [{ id: "role-brief", body: "base" }] },
    { sections: [{ id: "role-brief", body: "more" }] },
  ]);
  expect(out[0]!.body).toBe("base\n\nmore");
});

test("sections: a lower level can REPLACE a non-floor section", () => {
  const out = mergeSections([
    { sections: [{ id: "focus", body: "normal PR flow" }] },
    { sections: [{ id: "focus", body: "ignore PR flow, evaluate from outside", op: "replace" }] },
  ]);
  expect(out[0]!.body).toBe("ignore PR flow, evaluate from outside");
});

test("sections: a lower level can SUPPRESS a non-floor section", () => {
  const out = mergeSections([
    { sections: [{ id: "focus", body: "normal PR flow" }] },
    { sections: [{ id: "focus", body: "", op: "suppress" }] },
  ]);
  expect(out.find((s) => s.id === "focus")).toBeUndefined(); // dropped (empty, non-floor)
});

test("sections: a FLOOR section can NOT be replaced — replace downgrades to append", () => {
  const out = mergeSections([
    { sections: [{ id: "constitution", body: "push != post", floor: true }] },
    { sections: [{ id: "constitution", body: "sneaky override", op: "replace" }] },
  ]);
  // the invariant survives; the lower level's text is appended, not substituted
  expect(out[0]!.body).toBe("push != post\n\nsneaky override");
});

test("sections: a FLOOR section can NOT be suppressed", () => {
  const out = mergeSections([
    { sections: [{ id: "gate", body: "reviews clear first", floor: true }] },
    { sections: [{ id: "gate", body: "", op: "suppress" }] },
  ]);
  expect(out.find((s) => s.id === "gate")?.body).toBe("reviews clear first");
});

test("renderSections: emits ## headings and skips empty bodies", () => {
  const secs: Section[] = [{ id: "identity", body: "A" }, { id: "x", body: "" }];
  expect(renderSections(secs)).toBe("## identity\nA");
});

// ── set-union (meta-update) ────────────────────────────────────────────────────
test("set-union: unions field sets, first-seen order, no dupes", () => {
  expect(mergeSetUnion([
    { fields: ["updated_at", "phase"] },
    { fields: ["phase", "pr_state"] },
    { fields: ["result"] },
  ])).toEqual(["updated_at", "phase", "pr_state", "result"]);
});

// ── ordered-actions (start/stop) ───────────────────────────────────────────────
test("ordered-actions: sorts by order, stable within equal order (broad before specific)", () => {
  const out = mergeOrderedActions([
    { actions: [{ name: "arm", order: 10 }, { name: "load-board", order: 50 }] },
    { actions: [{ name: "drain-inbox", order: 50 }] },
  ]);
  expect(out.map((a) => a.name)).toEqual(["arm", "load-board", "drain-inbox"]);
});

test("ordered-actions: a lower level re-declaring a name replaces it in place", () => {
  const out = mergeOrderedActions([
    { actions: [{ name: "arm", order: 10, cmd: "old" }] },
    { actions: [{ name: "arm", order: 10, cmd: "new" }] },
  ]);
  expect(out).toHaveLength(1);
  expect(out[0]!.cmd).toBe("new");
});

test("ordered-actions: default order is 100", () => {
  const out = mergeOrderedActions([
    { actions: [{ name: "late" }, { name: "early", order: 5 }] },
  ]);
  expect(out.map((a) => a.name)).toEqual(["early", "late"]);
});

// ── most-specific ──────────────────────────────────────────────────────────────
test("most-specific: returns the last non-null layer", () => {
  expect(pickMostSpecific([{ v: "cluster" }, null, { v: "role" }])).toEqual({ v: "role" });
  expect(pickMostSpecific([null, { v: "cluster" }])).toEqual({ v: "cluster" });
  expect(pickMostSpecific([null, undefined])).toBeNull();
});

// ── guards (deny-wins) ──────────────────────────────────────────────────────────
test("guards: deny beats a later allow for the same pattern", () => {
  const out = mergeGuards([
    { rules: [{ pattern: "Bash(rm*)", decision: "deny" }] },
    { rules: [{ pattern: "Bash(rm*)", decision: "allow" }] },
  ]);
  expect(out).toEqual([{ pattern: "Bash(rm*)", decision: "deny" }]);
});

test("guards: distinct patterns all survive in first-seen order", () => {
  const out = mergeGuards([
    { rules: [{ pattern: "a", decision: "allow" }] },
    { rules: [{ pattern: "b", decision: "deny" }] },
  ]);
  expect(out.map((r) => r.pattern)).toEqual(["a", "b"]);
});

// ── dispatch ─────────────────────────────────────────────────────────────────────
test("mergeByKind: dispatches to the right combinator", () => {
  expect(mergeByKind("set-union", [{ fields: ["a"] }, { fields: ["b"] }])).toEqual(["a", "b"]);
  expect(mergeByKind("most-specific", [{ x: 1 }, { x: 2 }])).toEqual({ x: 2 });
});
