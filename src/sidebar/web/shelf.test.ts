import { test, expect } from "bun:test";
import {
  canFilterLive,
  isLiveRow,
  OPEN_SHELF,
  parseShelfStates,
  serializeShelfStates,
  shelfRows,
  toggleLiveOnly,
  toggleShelved,
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

test("each control is binary and reversible in one click", () => {
  expect(toggleShelved(OPEN_SHELF)).toEqual({ shelved: true, liveOnly: false });
  expect(toggleShelved(toggleShelved(OPEN_SHELF))).toEqual(OPEN_SHELF);
  expect(toggleLiveOnly(OPEN_SHELF)).toEqual({ shelved: false, liveOnly: true });
  expect(toggleLiveOnly(toggleLiveOnly(OPEN_SHELF))).toEqual(OPEN_SHELF);
});

// The reason the two facts are kept apart rather than cycled: shelving a filtered group and
// unshelving it must give back the view you left, not a reset one.
test("the controls do not disturb each other", () => {
  const filtered = toggleLiveOnly(OPEN_SHELF);
  const shelved = toggleShelved(filtered);
  expect(shelved).toEqual({ shelved: true, liveOnly: true });
  expect(toggleShelved(shelved)).toEqual(filtered);
});

test("each state shows what it claims", () => {
  const rows = [liveSession, closedSession, tab, settledSession];
  expect(shelfRows(rows, OPEN_SHELF)).toHaveLength(4);
  expect(shelfRows(rows, { shelved: false, liveOnly: true })).toEqual([liveSession, tab]);
  expect(shelfRows(rows, { shelved: true, liveOnly: false })).toHaveLength(0);
  expect(shelfRows(rows, { shelved: true, liveOnly: true })).toHaveLength(0);
});

// Two older formats exist in the wild. Dropping either silently reopens sections someone shelved.
test("the original collapsed-key array still reads as shelved", () => {
  const states = parseShelfStates(JSON.stringify(["completed", "saved", "milad-vault"]));
  expect(states.get("completed")).toEqual({ shelved: true, liveOnly: false });
  expect(states.get("milad-vault")).toEqual({ shelved: true, liveOnly: false });
  expect(states.size).toBe(3);
});

test("the three-state cycle that briefly replaced it still reads back", () => {
  const states = parseShelfStates(JSON.stringify({ a: "all", b: "live", c: "collapsed" }));
  expect(states.get("a")).toEqual(OPEN_SHELF);
  expect(states.get("b")).toEqual({ shelved: false, liveOnly: true });
  expect(states.get("c")).toEqual({ shelved: true, liveOnly: false });
});

test("dedicated lifecycle views start open when nothing is stored", () => {
  expect(parseShelfStates(null)).toEqual(new Map());
});

test("unreadable or nonsense storage falls back rather than throwing", () => {
  expect(parseShelfStates("{not json")).toEqual(new Map());
  expect(parseShelfStates("42")).toEqual(new Map());
});

test("a state this build does not understand is dropped, not trusted", () => {
  const states = parseShelfStates(JSON.stringify({ a: "live", b: "sideways", c: "collapsed" }));
  expect(states.get("a")).toEqual({ shelved: false, liveOnly: true });
  expect(states.has("b")).toBe(false);
  expect(states.get("c")).toEqual({ shelved: true, liveOnly: false });
});

test("every combination survives a round trip through storage", () => {
  const original = new Map<string, ShelfState>([
    ["a", OPEN_SHELF],
    ["b", { shelved: false, liveOnly: true }],
    ["c", { shelved: true, liveOnly: false }],
    ["d", { shelved: true, liveOnly: true }],
  ]);
  expect(parseShelfStates(serializeShelfStates(original))).toEqual(original);
});
