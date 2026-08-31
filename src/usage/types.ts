/**
 * The evidence contract for `ccs usage`. Every number the utility reports is a
 * UsageObservation: it carries WHERE the number came from (source), WHOSE allowance it
 * consumes (scope), WHEN it was seen, and whether it is exact. Quota kinds are never
 * flattened into one percentage — an unknown beats fake precision, so `used`/`remaining`
 * may be null while the observation still ships.
 */

export type ProviderId = "codex" | "anthropic" | "grok" | "opencode-go" | "venice";

export type MetricKind = "allowance" | "rate_limit" | "credit" | "reset_credit" | "cost" | "capacity";

export type ObservationScope =
  | "account"
  | "organization"
  | "project"
  | "key"
  | "model"
  | "machine";

export type UsageWindow = "minute" | "five_hour" | "daily" | "weekly" | "monthly" | null;

/** The five evidence classes, strongest to weakest. See docs/plans/unified-usage-utility.html. */
export type SourceClass =
  | "official_api"
  | "provider_header"
  | "official_ui"
  | "official_cli"
  | "observed_private"
  | "local_estimate";

export interface UsageObservation {
  provider: ProviderId;
  /** Stable id for the entitlement this consumes, e.g. "codex-pro", "claude-max-personal". */
  entitlement: string;
  metric: MetricKind;
  scope: ObservationScope;
  window: UsageWindow;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
  expiresAt: string | null;
  observedAt: string;
  source: SourceClass;
  exact: boolean;
  /** True when the source could not refresh and this is its last-good snapshot. */
  stale?: boolean;
}

/** Adapter health, surfaced by `ccs usage doctor` and embedded in every snapshot. */
export interface AdapterHealth {
  provider: ProviderId;
  status: "ok" | "degraded" | "unavailable";
  /** Human-readable reason when not ok (missing helper, broken auth, parse failure). */
  detail: string | null;
  /** Helper identity where an external tool supplied the data. */
  helper?: { name: string; version: string };
}

export interface UsageSnapshot {
  generatedAt: string;
  observations: UsageObservation[];
  adapters: AdapterHealth[];
}
