/**
 * API-equivalent cost of a Session, computed from the exact `usage` objects the API
 * returned (persisted on every assistant line of the transcript). These are the billed
 * token counts, not estimates — summing them × per-model pricing reproduces list-price
 * cost exactly. On a subscription this is notional spend, but it's the right metric for
 * comparing sessions/loops.
 */

/** Billed token totals + cost for one Session file. */
export interface UsageTotals {
  readonly costUSD: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly webSearches: number;
  /** USD per model id — unknown models appear with 0 so a pricing gap is visible, not silent. */
  readonly costByModel: Readonly<Record<string, number>>;
}

/** The shape of a transcript line the accumulator cares about (assistant lines). */
export interface CostLine {
  requestId?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: RawUsage;
  };
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  server_tool_use?: { web_search_requests?: number };
}

// Cache pricing is uniform across models, as multiples of the input price.
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2.0;
// Web search is $10 per 1k requests (web fetch has no per-request fee).
const WEB_SEARCH_USD = 0.01;

/** USD per million tokens, matched by model-id prefix (ids may carry date suffixes). */
const PRICES: ReadonlyArray<readonly [prefix: string, input: number, output: number]> = [
  // GPT gateway sessions retain their served model ids in transcript usage. These are
  // API-equivalent list prices; subscription-backed runs remain notional, like Claude runs.
  ["gpt-5.6-sol", 5, 30],
  ["gpt-5.6-terra", 2.5, 15],
  ["gpt-5.6-luna", 1, 6],
  ["gpt-5.5", 5, 30],
  ["claude-fable-5", 10, 50],
  ["claude-mythos", 10, 50],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-opus-4-5", 5, 25],
  ["claude-opus-4-1", 15, 75],
  ["claude-opus-4-2", 15, 75], // claude-opus-4-20250514
  ["claude-3-opus", 15, 75],
  // claude-sonnet-5 is priced in priceFor() — its intro pricing is date-conditional.
  ["claude-sonnet-4", 3, 15],
  ["claude-3-7-sonnet", 3, 15],
  ["claude-3-5-sonnet", 3, 15],
  ["claude-haiku-4-5", 1, 5],
  ["claude-3-5-haiku", 0.8, 4],
  ["claude-3-haiku", 0.25, 1.25],
];

// Sonnet 5 bills $2/$10 introductory through 2026-08-31, $3/$15 after.
const SONNET5_INTRO_END = Date.parse("2026-09-01T00:00:00Z");

function priceFor(
  model: string,
  timestamp: string | undefined,
): { input: number; output: number } | null {
  if (model.startsWith("claude-sonnet-5")) {
    const ts = timestamp ? Date.parse(timestamp) : NaN;
    const intro = !Number.isNaN(ts) && ts < SONNET5_INTRO_END;
    return intro ? { input: 2, output: 10 } : { input: 3, output: 15 };
  }
  for (const [prefix, input, output] of PRICES) {
    if (model.startsWith(prefix)) return { input, output };
  }
  return null;
}

export interface UsageAccumulator {
  /** Feed one parsed assistant line. Lines without `message.usage` are ignored. */
  add(line: CostLine): void;
  totals(): UsageTotals;
}

/**
 * Streaming usage summer for one Session file. Dedupes on message.id + requestId —
 * Claude Code writes one line per content block during streaming, all sharing the same
 * API response (and usage), so a message must be counted once, not once per line.
 */
export function createUsageAccumulator(): UsageAccumulator {
  const seen = new Set<string>();
  let costUSD = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite5m = 0;
  let cacheWrite1h = 0;
  let webSearches = 0;
  const costByModel: Record<string, number> = {};

  return {
    add(line: CostLine): void {
      const usage = line.message?.usage;
      if (!usage) return;

      const msgId = line.message?.id;
      if (msgId || line.requestId) {
        const key = `${msgId ?? ""}:${line.requestId ?? ""}`;
        if (seen.has(key)) return;
        seen.add(key);
      }

      const inTok = usage.input_tokens ?? 0;
      const outTok = usage.output_tokens ?? 0;
      const readTok = usage.cache_read_input_tokens ?? 0;
      // Prefer the tiered breakdown (5m writes bill 1.25×, 1h writes 2×); older
      // transcripts only have the flat count, which was always the 5m tier.
      const tiers = usage.cache_creation;
      const write5m = tiers?.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0;
      const write1h = tiers?.ephemeral_1h_input_tokens ?? 0;
      const searches = usage.server_tool_use?.web_search_requests ?? 0;

      input += inTok;
      output += outTok;
      cacheRead += readTok;
      cacheWrite5m += write5m;
      cacheWrite1h += write1h;
      webSearches += searches;

      const model = line.message?.model ?? "";
      const price = model ? priceFor(model, line.timestamp) : null;
      let cost = searches * WEB_SEARCH_USD;
      if (price) {
        cost +=
          (inTok * price.input +
            outTok * price.output +
            readTok * price.input * CACHE_READ_MULT +
            write5m * price.input * CACHE_WRITE_5M_MULT +
            write1h * price.input * CACHE_WRITE_1H_MULT) /
          1_000_000;
      }
      costUSD += cost;
      if (model && model !== "<synthetic>") {
        costByModel[model] = (costByModel[model] ?? 0) + cost;
      }
    },

    totals(): UsageTotals {
      return {
        costUSD,
        input,
        output,
        cacheRead,
        cacheWrite5m,
        cacheWrite1h,
        webSearches,
        costByModel,
      };
    },
  };
}

/** Format a token count compactly: "0", "845", "12.3k", "4.1M". */
export function formatTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Format a USD amount compactly for table columns: "" for 0, "43¢", "$4.12", "$312". */
export function formatCost(usd: number): string {
  if (usd <= 0) return "";
  if (usd < 0.995) return `${Math.max(1, Math.round(usd * 100))}¢`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}
