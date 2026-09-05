import { displayModelRegistry, priceFor as registryPriceFor } from "./models/registry.ts";

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
  /** Sorted, deduped model ids seen in assistant turns. */
  readonly models: readonly string[];
  /**
   * Model id of the LAST assistant turn, or null when there were none. `models` is sorted for
   * display and so loses arrival order, but resume routing needs the most recent backend: a
   * transcript that changed harness mid-session only has to be replayable by the harness it
   * ended on, not by every one it ever used.
   */
  readonly lastModel: string | null;
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

function priceFor(
  model: string,
  timestamp: string | undefined,
): { input: number; output: number } | null {
  const registry = displayModelRegistry();
  return registry ? registryPriceFor(registry, model, timestamp) : null;
}

export interface UsageAccumulator {
  /** Feed one parsed assistant line. Lines without usage still contribute their model id. */
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
  const models = new Set<string>();
  let lastModel: string | null = null;

  return {
    add(line: CostLine): void {
      const model = line.message?.model ?? "";
      if (model && model !== "<synthetic>") {
        models.add(model);
        lastModel = model;
      }

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
        models: [...models].sort(),
        lastModel,
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
