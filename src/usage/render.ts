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

/** Entitlement overrides so distinct allowances never share one provider label. */
const ENTITLEMENT_LABEL: Record<string, string> = {
  "codex-spark": "Codex Spark",
  "codex-spark-weekly": "Codex Spark Weekly",
  "codex-reset-credit": "Codex reset",
  "codex-dollar-credit": "Codex credits",
  "venice-usd-balance": "Venice USD",
  "venice-diem-balance": "Venice DIEM",
  "venice-model-caps": "Venice caps",
};

function labelFor(o: UsageObservation): string {
  const override = ENTITLEMENT_LABEL[o.entitlement];
  if (override) return override;
  const base = PROVIDER_LABEL[o.provider] ?? o.provider;
  // Multi-account entitlements carry ":<email>" — surface which account, not just the provider.
  if (o.entitlement.includes(":")) return `${base} (${o.entitlement.slice(o.entitlement.indexOf(":") + 1)})`;
  return base;
}

/** Credit rendering is currency-aware: DIEM is not dollars. */
function creditAmount(entitlement: string, remaining: number | null): string {
  if (remaining === null) return "?";
  if (entitlement === "venice-diem-balance") return `${remaining} DIEM`;
  return remaining === 0 ? "$0" : formatCost(remaining);
}

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
  const label = `${labelFor(o).padEnd(14)}`;
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
      bits.push(`${creditAmount(o.entitlement, o.remaining)} remaining`);
      if (o.resetsAt) bits.push(`epoch resets ${shortReset(o.resetsAt)}`);
      break;
    default:
      bits.push(o.entitlement);
  }
  if (o.source === "local_estimate") bits.push("(estimate)");
  else if (!o.exact && o.metric === "allowance") bits.push("provider-rounded");
  return `  ${label} ${bits.join(" · ")}`;
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
  const available = rest.filter((o) => o.metric !== "rate_limit");
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
    // One summary line for reference-data caps; --json carries every per-model entry.
    const lo = Math.min(...caps.map((o) => o.limit ?? Infinity));
    const hi = Math.max(...caps.map((o) => o.limit ?? 0));
    lines.push(`  ${"Venice caps".padEnd(14)} ${caps.length} models · ${lo}–${hi} req/min (full detail in --json)`);
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
