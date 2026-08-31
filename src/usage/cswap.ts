/**
 * cswap adapter source: Milad's Claude subscriptions (personal + AUF) are managed by
 * cswap, the multi-account Claude Code switcher. Its `cswap list --json` already fetches
 * live five-hour and weekly windows per account from Anthropic's OAuth usage endpoint,
 * which CodexBar's Claude reader cannot reach. We consume its JSON rather than
 * reimplementing credential handling — cswap owns the keychain and the polling.
 */

import { err, ok, type Result } from "../result.ts";
import type { AdapterHealth } from "./types.ts";

export interface CswapWindow {
  /** Present on scoped model-family windows such as Fable. */
  name?: string;
  pct?: number | null;
  resetsAt?: string | null;
  expectedPct?: number | null;
  aheadOfPace?: boolean | null;
  willLastToReset?: boolean | null;
}

export interface CswapAccount {
  number?: number;
  email?: string;
  organizationName?: string;
  active?: boolean;
  usageStatus?: string; // "ok" | "no_credentials" | ...
  usage?: {
    fiveHour?: CswapWindow | null;
    sevenDay?: CswapWindow | null;
    scoped?: CswapWindow[];
  } | null;
  lastGoodUsage?: {
    fiveHour?: CswapWindow | null;
    sevenDay?: CswapWindow | null;
    scoped?: CswapWindow[];
  } | null;
  /** When lastGoodUsage was actually fetched — the honest observedAt for fallbacks. */
  lastGoodFetchedAt?: string;
}

export interface CswapReport {
  schemaVersion?: number;
  accounts?: CswapAccount[];
}

const CSWAP_TIMEOUT_MS = 20_000;

export function runCswap(): Result<{ report: CswapReport }, AdapterHealth> {
  const bin = Bun.which("cswap");
  if (!bin) {
    return err({ provider: "anthropic", status: "unavailable", detail: "cswap not found on PATH" });
  }
  const proc = Bun.spawnSync([bin, "list", "--json"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: CSWAP_TIMEOUT_MS,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(proc.stdout));
  } catch {
    return err({
      provider: "anthropic",
      status: "unavailable",
      detail: `cswap list --json produced no JSON (exit ${proc.exitCode})`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as CswapReport).accounts)) {
    return err({ provider: "anthropic", status: "degraded", detail: "cswap JSON missing accounts array" });
  }
  return ok({ report: parsed as CswapReport });
}
