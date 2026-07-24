import { test, expect } from "bun:test";
import { createUsageAccumulator, formatCost, formatTokens, type CostLine } from "./cost.ts";

function line(over: Partial<CostLine> & { usage?: object; model?: string } = {}): CostLine {
  const { usage, model, ...rest } = over;
  return {
    requestId: over.requestId,
    timestamp: over.timestamp ?? "2026-07-01T00:00:00Z",
    message: {
      id: (rest.message as { id?: string } | undefined)?.id,
      model: model ?? "claude-opus-4-8",
      usage: usage ?? {},
    },
    ...rest,
  };
}

test("prices input/output tokens at the model's rates", () => {
  const acc = createUsageAccumulator();
  // Opus 4.8: $5/MTok in, $25/MTok out
  acc.add(line({ requestId: "r1", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }));
  expect(acc.totals().costUSD).toBeCloseTo(30, 6);
  expect(acc.totals().input).toBe(1_000_000);
  expect(acc.totals().output).toBe(1_000_000);
});

test("prices observed GPT gateway model ids at their API-equivalent rates", () => {
  const acc = createUsageAccumulator();
  acc.add(line({ requestId: "sol", model: "gpt-5.6-sol", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }));
  acc.add(line({ requestId: "terra", model: "gpt-5.6-terra[1m]", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }));
  acc.add(line({ requestId: "luna", model: "gpt-5.6-luna", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }));
  acc.add(line({ requestId: "55", model: "gpt-5.5", usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } }));
  expect(acc.totals().costUSD).toBeCloseTo(35 + 17.5 + 7 + 35, 6);
});

test("cache tiers bill at 0.1x read, 1.25x 5m write, 2x 1h write of input price", () => {
  const acc = createUsageAccumulator();
  acc.add(
    line({
      requestId: "r1",
      usage: {
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000, // flat total; tiers below are authoritative
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000,
        },
      },
    }),
  );
  // Opus input $5: read 0.5 + 5m write 6.25 + 1h write 10 = 16.75
  expect(acc.totals().costUSD).toBeCloseTo(16.75, 6);
  expect(acc.totals().cacheWrite5m).toBe(1_000_000);
  expect(acc.totals().cacheWrite1h).toBe(1_000_000);
});

test("falls back to the flat cache_creation count (as 5m) on old transcripts", () => {
  const acc = createUsageAccumulator();
  acc.add(line({ requestId: "r1", usage: { cache_creation_input_tokens: 1_000_000 } }));
  expect(acc.totals().cacheWrite5m).toBe(1_000_000);
  expect(acc.totals().costUSD).toBeCloseTo(6.25, 6); // 1M × $5 × 1.25
});

test("dedupes repeated lines sharing message.id + requestId (streaming writes)", () => {
  const acc = createUsageAccumulator();
  const usage = { input_tokens: 100, output_tokens: 50 };
  acc.add({ requestId: "req1", message: { id: "msg1", model: "claude-opus-4-8", usage } });
  acc.add({ requestId: "req1", message: { id: "msg1", model: "claude-opus-4-8", usage } });
  acc.add({ requestId: "req2", message: { id: "msg2", model: "claude-opus-4-8", usage } });
  expect(acc.totals().input).toBe(200);
  expect(acc.totals().output).toBe(100);
});

test("prices each message by its own model (mixed-model sessions)", () => {
  const acc = createUsageAccumulator();
  acc.add(line({ requestId: "r1", model: "claude-opus-4-8", usage: { output_tokens: 1_000_000 } }));
  acc.add(line({ requestId: "r2", model: "claude-haiku-4-5-20251001", usage: { output_tokens: 1_000_000 } }));
  const t = acc.totals();
  expect(t.costUSD).toBeCloseTo(25 + 5, 6);
  expect(Object.keys(t.costByModel).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-opus-4-8"]);
});

test("sonnet-5 intro pricing is date-conditional", () => {
  const intro = createUsageAccumulator();
  intro.add(
    line({
      requestId: "r1",
      model: "claude-sonnet-5",
      timestamp: "2026-07-01T00:00:00Z",
      usage: { output_tokens: 1_000_000 },
    }),
  );
  expect(intro.totals().costUSD).toBeCloseTo(10, 6); // intro $10/MTok out

  const post = createUsageAccumulator();
  post.add(
    line({
      requestId: "r1",
      model: "claude-sonnet-5",
      timestamp: "2026-10-01T00:00:00Z",
      usage: { output_tokens: 1_000_000 },
    }),
  );
  expect(post.totals().costUSD).toBeCloseTo(15, 6); // post-intro $15/MTok out
});

test("web searches bill $10 per 1k requests", () => {
  const acc = createUsageAccumulator();
  acc.add(line({ requestId: "r1", usage: { server_tool_use: { web_search_requests: 3 } } }));
  expect(acc.totals().costUSD).toBeCloseTo(0.03, 6);
  expect(acc.totals().webSearches).toBe(3);
});

test("unknown models count tokens but cost 0, and surface in costByModel", () => {
  const acc = createUsageAccumulator();
  acc.add(line({ requestId: "r1", model: "claude-future-9", usage: { input_tokens: 500 } }));
  expect(acc.totals().input).toBe(500);
  expect(acc.totals().costUSD).toBe(0);
  expect(acc.totals().costByModel["claude-future-9"]).toBe(0);
});

test("collects priced and unpriced models even from lines without usage", () => {
  const acc = createUsageAccumulator();
  acc.add({ message: { model: "gpt-5.6-sol" } });
  acc.add(line({ requestId: "r1", model: "claude-opus-4-8", usage: { input_tokens: 1 } }));
  expect(acc.totals().models).toEqual(["claude-opus-4-8", "gpt-5.6-sol"]);
});

test("model ids are deduped and sorted", () => {
  const acc = createUsageAccumulator();
  acc.add({ message: { id: "msg1", model: "gpt-5.6-sol" } });
  acc.add({ message: { id: "msg1", model: "gpt-5.6-sol" } });
  acc.add({ message: { model: "claude-sonnet-5" } });
  expect(acc.totals().models).toEqual(["claude-sonnet-5", "gpt-5.6-sol"]);
});

test("synthetic model is excluded from models and cost breakdown", () => {
  const acc = createUsageAccumulator();
  acc.add(line({ requestId: "r1", model: "<synthetic>", usage: { input_tokens: 0 } }));
  expect(acc.totals().costUSD).toBe(0);
  expect(Object.keys(acc.totals().costByModel)).toEqual([]);
  expect(acc.totals().models).toEqual([]);
});

test("formatCost renders compact column values", () => {
  expect(formatCost(0)).toBe("");
  expect(formatCost(0.004)).toBe("1¢");
  expect(formatCost(0.43)).toBe("43¢");
  expect(formatCost(4.118)).toBe("$4.12");
  expect(formatCost(312.4)).toBe("$312");
});

test("formatTokens renders compact counts", () => {
  expect(formatTokens(845)).toBe("845");
  expect(formatTokens(12_340)).toBe("12.3k");
  expect(formatTokens(4_100_000)).toBe("4.1M");
});
