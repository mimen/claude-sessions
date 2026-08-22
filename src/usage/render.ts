/**
 * Terminal rendering for `ccs usage`. Default output is an availability instrument:
 * ATTENTION (running out / expiring / exhausted) before AVAILABLE, unknowns stated
 * plainly, never one flattened percentage.
 */

import type { UsageObservation, UsageSnapshot } from "./types.ts";
import { formatCost } from "../cost.ts";

/** Sort key: the operational question order — running out first, then expiry, then rest. */
function urgency(o: UsageObservation): number {
  if (o.metric === "reset_credit" && o.expiresAt) return 1; // expires if ignored
  if (o.remaining !== null && o.limit !== null && o.limit > 0 && o.used !== null) {
    const frac = o.used / o.limit;
    if (frac >= 0.99) return 0; // exhausted
    if (frac >= 0.7) return 1;
  }
  return 2;
}

const PROVIDER_LABEL: Record<string, string> = {
  codex: "Codex Pro",
  anthropic: "Claude",
  grok: "Grok",
  "opencode-go": "OpenCode Go",
  venice: "Venice",
};

const WINDOW_LABEL: Record<string, string> = {
  minute: "per-minute",
  five_hour: "five-hour",
  daily: "daily",
  weekly: "weekly",
  monthly: "monthly",
};

/** "Thu 04:05" style short reset time; falls back to the raw ISO when unparseable. */
export function shortReset(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, {
    weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric",
  });
}

function lineFor(o: UsageObservation): string {
  const label = `${(PROVIDER_LABEL[o.provider] ?? o.provider).padEnd(14)}`;
  const bits: string[] = [];
  switch (o.metric) {
    case "allowance": {
      const w = o.window ? ` ${WINDOW_LABEL[o.window]}` : "";
      if (o.used !== null && o.limit !== null && o.limit > 0) {
        const pct = Math.round((o.used / o.limit) * 100);
        bits.push(pct >= 99 ? `${w} exhausted` : `${pct}% used${w}`);
      } else {
        bits.push(`allowance unknown${w}`);
      }
      if (o.resetsAt) bits.push(`resets ${shortReset(o.resetsAt)}`);
      break;
    }
    case "reset_credit":
      bits.push(
        o.remaining === 1
          ? "banked full reset available"
          : "reset credit consumed",
      );
      if (o.expiresAt) bits.push(`expires ${shortReset(o.expiresAt)}`);
      break;
    case "credit":
      bits.push(`${typeof o.remaining === "number" ? formatCredit(o.remaining) : "?"} remaining`);
      if (o.resetsAt) bits.push(`epoch resets ${shortReset(o.resetsAt)}`);
      break;
    default:
      bits.push(o.entitlement);
  }
  if (o.source === "local_estimate") bits.push("(estimate)");
  else if (!o.exact && o.metric === "allowance") bits.push("provider-rounded");
  return `  ${label} ${bits.join(" · ")}`;
}

/** Credit amounts print even at zero, unlike table-cost formatting. */
function formatCredit(usd: number): string {
  return usd === 0 ? "$0" : formatCost(usd);
}

export function renderSnapshot(snap: UsageSnapshot): string {
  const lines: string[] = [];
  const sorted = [...snap.observations].sort(
    (a, b) => urgency(a) - urgency(b) || a.provider.localeCompare(b.provider),
  );
  const attention = sorted.filter((o) => urgency(o) < 2);
  const rest = sorted.filter((o) => urgency(o) === 2);
  // Per-model rate-limit caps are reference data — summarize them to one line instead of
  // flooding the availability view; `--json` still carries every entry.
  const caps = rest.filter((o) => o.metric === "rate_limit");
  const available = [...rest.filter((o) => o.metric !== "rate_limit")];
  if (caps.length) {
    const min = Math.min(...caps.map((o) => o.limit ?? Infinity));
    const max = Math.max(...caps.map((o) => o.limit ?? 0));
    available.push({
      provider: "venice",
      entitlement: "venice-model-caps",
      metric: "capacity",
      scope: "account",
      window: "minute",
      used: null,
      limit: max,
      remaining: null,
      resetsAt: null,
      expiresAt: null,
      observedAt: caps[0]!.observedAt,
      source: "official_api",
      exact: true,
    });
    void min;
  }
  if (attention.length) {
    lines.push("ATTENTION");
    lines.push(...attention.map(lineFor));
    lines.push("");
  }
  if (available.length) {
    lines.push("AVAILABLE");
    lines.push(...available.map(lineFor));
  }
  if (caps.length) {
    lines.push(`  ${"(Venice per-model caps)".padEnd(14)} ${caps.length} models · ${Math.min(...caps.map((o) => o.limit ?? Infinity))}–${Math.max(...caps.map((o) => o.limit ?? 0))} req/min (full detail in --json)`);
  }
  const unhealthy = snap.adapters.filter((a) => a.status !== "ok");
  if (unhealthy.length) {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("UNAVAILABLE");
    for (const a of unhealthy) {
      lines.push(`  ${(PROVIDER_LABEL[a.provider] ?? a.provider).padEnd(14)} ${a.detail ?? a.status}`);
    }
  }
  return lines.join("\n");
}
