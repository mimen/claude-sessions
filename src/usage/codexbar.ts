/**
 * CodexBar entry shape kept so live OAuth readings and parked snapshots share one mapper.
 */

import type { UsageObservation } from "./types.ts";

export interface RawCodexBarEntry {
  provider?: string;
  /** Provenance for this entry: "oauth" | "web" | "cli" | … */
  source?: string;
  version?: string;
  error?: { code?: number; kind?: string; message?: string };
  usage?: unknown;
  /** Top-level paid credits (a sibling of `usage`, at least on Codex). */
  credits?: { remaining?: number; updatedAt?: string };
}

/** Map an entry source to the plan's evidence classes. */
export function sourceClassFor(entrySource: string | undefined): UsageObservation["source"] {
  switch (entrySource) {
    case "api":
    case "oauth":
      return "official_api";
    case "web":
      return "official_ui";
    case "cli":
      return "official_cli";
    default:
      return "official_cli";
  }
}
