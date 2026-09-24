import { expect, test } from "bun:test";
import { buildView, carryForward, ordered, reordered, type Observation, type Snapshot } from "./index.ts";

const at = "2026-09-24T08:00:00.000Z";
const reset = "2026-09-29T21:00:00.000Z";

function obs(entitlement: string, over: Partial<Observation> = {}): Observation {
  const provider = entitlement.startsWith("claude") ? "anthropic" : entitlement.startsWith("grok") ? "grok" : "codex";
  return { provider, entitlement, metric: "allowance", window: "weekly", used: 50, limit: 100, resetsAt: reset, observedAt: at, ...over };
}

const personal = "miladmaaan@gmail.com";
const auf = "milad@afternoonumbrellafriends.com";

function snapshot(observations: Observation[], extra: Partial<Snapshot> = {}): Snapshot {
  return { generatedAt: at, observations, adapters: [], subscriptions: [], ...extra };
}

test("one section per provider and account, labelled by email, rows in window order", () => {
  const view = buildView(snapshot([
    obs(`claude-max:${personal}`, { window: "weekly", used: 3 }),
    obs(`claude-max:${personal}#Fable`, { used: 0 }),
    obs(`claude-max:${personal}`, { window: "five_hour", used: 9 }),
    obs(`claude-max:${auf}`, { used: 24 }),
  ]));
  expect(view.sections.map(s => [s.id, s.title, s.account])).toEqual([
    [`anthropic|${personal}`, "Claude", personal],
    [`anthropic|${auf}`, "Claude", auf],
  ]);
  expect(view.sections[0]!.rows.map(r => r.label + (r.kind === "allowance" ? ` ${r.window}` : ""))).toEqual([
    "All models 5h", "All models wk", "Fable wk",
  ]);
});

test("Grok's product rows become segments of the pool bar, sorted fullest first", () => {
  const view = buildView(snapshot([
    obs(`grok-super grok plus:${personal}`, { used: 67 }),
    obs(`grok-super grok plus:${personal}#build`, { used: 27 }),
    obs(`grok-super grok plus:${personal}#imagine`, { used: 40 }),
    obs(`grok-super grok plus:${personal}#prepaid`, { metric: "credit", remaining: 0, window: null }),
  ]));
  const rows = view.sections[0]!.rows;
  expect(rows.map(r => r.kind)).toEqual(["allowance", "credit"]);
  expect(rows[0]!.kind === "allowance" && rows[0]!.segments).toEqual([
    { name: "Imagine", fractionUsed: 0.4 }, { name: "Build", fractionUsed: 0.27 },
  ]);
  expect(rows[1]).toMatchObject({ kind: "credit", label: "Extra credits", balance: 0, unit: "USD" });
});

test("a plan comes from the configured subscription or Claude's tier, never a per-account table", () => {
  const view = buildView(snapshot([
    obs(`claude-max:${auf}`, { tier: "default_claude_max_20x" }),
    obs(`codex-pro:${personal}`),
    obs(`claude-max:${personal}`, { tier: "default_claude_max_5x" }),
  ], { subscriptions: [{ provider: "anthropic", account: personal, planName: "Max 20x", monthlyDollars: 200, renewsOn: "2026-10-10" }] }));
  expect(view.sections.map(s => [s.account, s.plan, s.renewsOn])).toEqual([
    [auf, { name: "Max 20x", dollars: 200 }, null],
    [personal, null, null],
    [personal, { name: "Max 20x", dollars: 200 }, "2026-10-10"],
  ]);
  expect(view.bill).toEqual({ total: 400, planCount: 2 });
});

test("the overall reading is dollar-weighted and ignores the nested Fable cap", () => {
  const view = buildView(snapshot([
    obs(`claude-max:${personal}`, { used: 48, tier: "max_20x" }),
    obs(`claude-max:${personal}#Fable`, { used: 95 }),
    obs(`codex-pro:${personal}`, { used: 10 }),
  ]));
  // Claude weighs 200, Codex has no plan and weighs 50.
  expect(view.overall.sevenDay).toBeCloseTo((0.48 * 200 + 0.1 * 50) / 250, 6);
  expect(view.overall.fiveHour).toBeCloseTo((0.48 * 200 + 0.1 * 50) / 250, 6);
});

test("a saved order moves sections and rows; anything it doesn't name keeps its natural place after", () => {
  const snap = snapshot([
    obs(`claude-max:${personal}`, { window: "five_hour" }),
    obs(`claude-max:${personal}`),
    obs(`claude-max:${personal}#Fable`),
    obs(`codex-pro:${personal}`),
    obs(`grok-super grok plus:${personal}`),
  ]);
  const view = buildView(snap, {
    sections: [`grok|${personal}`, "gone|nobody", `anthropic|${personal}`],
    rows: { [`anthropic|${personal}`]: [`anthropic|claude-max:${personal}#Fable|weekly`] },
  });
  expect(view.sections.map(s => s.provider)).toEqual(["grok", "anthropic", "codex"]);
  expect(view.sections[1]!.rows.map(r => r.id)).toEqual([
    `anthropic|claude-max:${personal}#Fable|weekly`,
    `anthropic|claude-max:${personal}|five_hour`,
    `anthropic|claude-max:${personal}|weekly`,
  ]);
});

test("a drag reaches every slot", () => {
  expect(reordered(["a", "b", "c", "d"], "a", "d")).toEqual(["b", "c", "d", "a"]);
  expect(reordered(["a", "b", "c", "d"], "d", "a")).toEqual(["d", "a", "b", "c"]);
  expect(reordered(["a", "b", "c", "d"], "b", "c")).toEqual(["a", "c", "b", "d"]);
  expect(reordered(["a", "b"], "b", "b")).toEqual(["a", "b"]);
  expect(ordered(["x", "y", "z"], [], s => s)).toEqual(["x", "y", "z"]);
});

test("an unreachable provider keeps its previous rows, marked stale, aged from the real fetch", () => {
  const old = "2026-09-24T07:00:00.000Z";
  const previous = snapshot([obs(`grok-super grok plus:${personal}`, { used: 40, observedAt: old }), obs(`codex-pro:${personal}`, { used: 10 })]);
  const next = snapshot([obs(`codex-pro:${personal}`, { used: 12 })], {
    adapters: [{ provider: "grok", status: "unavailable", detail: "HTTP 500" }, { provider: "codex", status: "ok" }],
  });
  const view = buildView(carryForward(next, previous));
  expect(view.sections.map(s => [s.provider, s.staleSince])).toEqual([["codex", null], ["grok", Date.parse(old)]]);
  expect(view.notes).toEqual(["Grok: HTTP 500"]);
  // A provider that simply stopped being reported is not resurrected.
  expect(carryForward(snapshot([obs(`codex-pro:${personal}`)]), previous).observations).toHaveLength(1);
});

test("repeated entitlements keep unique row ids", () => {
  const view = buildView(snapshot([
    obs(`codex-reset-credit:${personal}`, { metric: "reset_credit", remaining: 1, window: null, expiresAt: null }),
    obs(`codex-reset-credit:${personal}`, { metric: "reset_credit", remaining: 1, window: null, expiresAt: null }),
  ]));
  const ids = view.sections[0]!.rows.map(r => r.id);
  expect(new Set(ids).size).toBe(2);
});
