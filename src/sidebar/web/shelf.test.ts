import { test, expect } from "bun:test";
import {
  canFilterLive,
  isLiveRow,
  nextShelfState,
  parseShelfStates,
  serializeShelfStates,
  shelfRows,
  type ShelfState,
} from "./format.ts";

const liveSession = { kind: "session", density: "full" } as const;
const closedSession = { kind: "session", density: "line" } as const;
const settledSession = { kind: "session", density: "settled" } as const;
const tab = { kind: "workspace" } as const;

test("live means running: an open session or any cmux tab", () => {
  expect(isLiveRow(liveSession)).toBe(true);
  expect(isLiveRow(tab)).toBe(true);
  expect(isLiveRow(closedSession)).toBe(false);
  expect(isLiveRow(settledSession)).toBe(false);
});

test("only a group holding both kinds can filter", () => {
  expect(canFilterLive([liveSession, closedSession])).toBe(true);
  expect(canFilterLive([tab, settledSession])).toBe(true);
  expect(canFilterLive([liveSession, liveSession])).toBe(false);
  expect(canFilterLive([closedSession, settledSession])).toBe(false);
  expect(canFilterLive([])).toBe(false);
});

// The whole point of gating the middle stop: under "by status" no group is ever mixed, so a
// three-stop cycle there would spend a click on a state that changes nothing.
test("a filterable group cycles through three states, an unfilterable one through two", () => {
  const cycle = (filterable: boolean): ShelfState[] => {
    const seen: ShelfState[] = [];
    let state: ShelfState = "all";
    for (let i = 0; i < 3; i++) {
      state = nextShelfState(state, filterable);
      seen.push(state);
    }
    return seen;
  };
  expect(cycle(true)).toEqual(["live", "collapsed", "all"]);
  expect(cycle(false)).toEqual(["collapsed", "all", "collapsed"]);
});

test("collapsed always reopens to everything, never to a filtered view", () => {
  expect(nextShelfState("collapsed", true)).toBe("all");
  expect(nextShelfState("collapsed", false)).toBe("all");
});

test("each state shows what it claims", () => {
  const rows = [liveSession, closedSession, tab, settledSession];
  expect(shelfRows(rows, "all")).toHaveLength(4);
  expect(shelfRows(rows, "live")).toEqual([liveSession, tab]);
  expect(shelfRows(rows, "collapsed")).toHaveLength(0);
});

// Every existing install has the old shape on disk. Dropping it would silently reopen every
// section someone had shelved, which is worse than the feature is good.
test("the older collapsed-key array still reads as collapsed", () => {
  const states = parseShelfStates(JSON.stringify(["completed", "archived", "milad-vault"]));
  expect(states.get("completed")).toBe("collapsed");
  expect(states.get("milad-vault")).toBe("collapsed");
  expect(states.size).toBe(3);
});

test("finished sections start shelved when nothing is stored", () => {
  expect([...parseShelfStates(null).entries()].sort()).toEqual([
    ["archived", "collapsed"],
    ["completed", "collapsed"],
  ]);
});

test("unreadable or nonsense storage falls back rather than throwing", () => {
  expect(parseShelfStates("{not json").get("archived")).toBe("collapsed");
  expect(parseShelfStates("42").get("archived")).toBe("collapsed");
});

test("a state this build does not understand is dropped, not trusted", () => {
  const states = parseShelfStates(JSON.stringify({ a: "live", b: "sideways", c: "collapsed" }));
  expect(states.get("a")).toBe("live");
  expect(states.has("b")).toBe(false);
  expect(states.get("c")).toBe("collapsed");
});

test("states survive a round trip through storage", () => {
  const original = new Map<string, ShelfState>([["p", "live"], ["q", "collapsed"], ["r", "all"]]);
  expect(parseShelfStates(serializeShelfStates(original))).toEqual(original);
});
