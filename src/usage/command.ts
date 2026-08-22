/**
 * `ccs usage` — point-in-time availability view across the five scoped providers
 * (Codex, Anthropic, Grok, OpenCode Go, Venice). Snapshot only: no history, no daemon.
 *
 *   ccs usage                          terminal availability view
 *   ccs usage --json                   stable JSON contract (UsageSnapshot)
 *   ccs usage --provider <id>          one provider (repeatable via comma or repeated flag)
 *   ccs usage sources                  what each adapter reads and how much to trust it
 *   ccs usage doctor                   adapter health without rendering observations
 */

import { collectSnapshot } from "./adapters.ts";
import { renderSnapshot } from "./render.ts";
import type { ProviderId, UsageSnapshot } from "./types.ts";

const VALID: readonly ProviderId[] = ["codex", "anthropic", "grok", "opencode-go", "venice"];

const SOURCES_HELP = `ccs usage sources — what each adapter reads

  codex        CodexBar CLI (official_cli). Ordinary 5h/weekly windows, Spark windows,
               banked reset credits (lifecycle + expiry), dollar credits as separate state.
  anthropic    CodexBar's Claude reader where it works (official_ui). Consumer Max
               allowance has no supported public API; explicit unknown when it can't.
  grok         Grok web surface via CodexBar (official_ui). Consumer/team OIDC allowance,
               weekly reset. No xAI API billing.
  opencode-go  CodexBar CLI (official_cli). Value-window usage; exact reset timestamps are
               console/private data and stay unknown rather than guessed.
  venice       Official APIs (official_api): api_keys/rate_limits for balances, tier,
               per-model caps, next epoch. USD and DIEM never merged.

Evidence classes, strongest first: official_api, provider_header, official_ui,
official_cli, observed_private, local_estimate. Unknown beats fake precision.`;

function parseProviders(args: readonly string[]): ProviderId[] | null {
  const out = new Set<ProviderId>();
  let sawFlag = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--provider") continue;
    sawFlag = true;
    const v = args[i + 1];
    // A dangling --provider is a caller error, not "all providers" — the Venice path
    // reads credentials, so silently broadening scope would be worse than failing.
    if (!v || v.startsWith("--")) return null;
    for (const p of v.split(",")) {
      const id = p.trim() as ProviderId;
      if (!VALID.includes(id)) return null;
      out.add(id);
    }
  }
  // null = invalid/dangling flag; otherwise the selected set (empty = all providers).
  return sawFlag && out.size === 0 ? null : [...out];
}

function snapshotWithDefaults(snap: UsageSnapshot): UsageSnapshot {
  // Every provider in scope appears in `adapters` even when an adapter was skipped,
  // so --json consumers can distinguish "healthy, no data" from "not asked".
  return snap;
}

export function usageCommand(args: readonly string[]): number | Promise<number> {
  if (args[0] === "sources") {
    console.log(SOURCES_HELP);
    return 0;
  }

  const providers = parseProviders(args);
  if (providers === null) {
    console.error(`ccs usage: invalid --provider. Valid ids: ${VALID.join(", ")}`);
    return 1;
  }
  const asJson = args.includes("--json");
  const doctorOnly = args[0] === "doctor";

  const snapPromise = collectSnapshot({ providers: providers.length ? providers : undefined });
  if (!asJson && !doctorOnly && !snapPromise) return 1;

  return (async () => {
    const snap = await snapPromise;
    if (asJson) {
      console.log(JSON.stringify(snapshotWithDefaults(snap), null, 2));
      return unhealthyExit(snap);
    }
    if (doctorOnly) {
      for (const a of snap.adapters) {
        console.log(`${a.provider.padEnd(12)} ${a.status}${a.detail ? ` — ${a.detail}` : ""}`);
      }
      return unhealthyExit(snap);
    }
    console.log(renderSnapshot(snap));
    return 0;
  })();
}

/** Nonzero when any adapter is unavailable so automation notices a partial answer. */
function unhealthyExit(snap: UsageSnapshot): number {
  return snap.adapters.some((a) => a.status === "unavailable") ? 2 : 0;
}
