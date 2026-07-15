/**
 * `ccs context-check` — mechanical context-budget guard for long-lived loop sessions.
 *
 * A `/loop`-style session (pr-watch control + concierge) grows a bit each tick and can drift
 * toward the model's input ceiling. Autocompact does not reliably fire in headless loops
 * (observed 2026-07-02: a tick failed at 98% because autocompact never triggered), so we run
 * this cheap guard at the TOP of every tick: read the CALLER's transcript, compute peak
 * context tokens from usage records, print OK / WARN / CRITICAL + a directive telling the loop
 * whether to compact now or after the tick.
 *
 * Any long-running loop can wire this into its command block — it has no cluster coupling.
 * The caller is identified by `CLAUDE_CODE_SESSION_ID` (Claude Code injects this into every
 * hook + command-block invocation), so no signal-density guessing is needed.
 *
 * Usage:
 *   ccs context-check                # prints one line: "context: OK (32%) — healthy"
 *   ccs context-check --json         # machine-readable {status,pct,tokens,directive,transcript}
 *
 * Exit code is always 0 — the directive is the payload, not the exit status.
 */

import { existsSync, readFileSync } from "node:fs";
import { openIndex } from "../index/schema.ts";
import { DB_PATH } from "../paths.ts";

const CONTEXT_LIMIT = 1_000_000; // Opus 1M window; overridable via CCS_CONTEXT_LIMIT for testing
const WARN_PCT = 70;
const CRIT_PCT = 82; // act well before the hard ceiling; the injected board is large

interface Assessment {
  status: "OK" | "WARN" | "CRITICAL" | "UNKNOWN";
  pct: number | null;
  tokens: number | null;
  directive: string;
  transcript: string | null;
}

function findTranscriptPath(sessionId: string): string | null {
  // A fresh CCS_ROOT has no ~/.ccs/cache/index.db yet; opening it would crash
  // with SQLITE_CANTOPEN. context-check runs from within loop hooks that
  // always have prior DB state, so this is defensive — but still: no crash
  // on cold-run.
  if (!existsSync(DB_PATH())) return null;
  const db = openIndex(DB_PATH());
  try {
    const row = db
      .query("SELECT path FROM sessions WHERE session_id = $id OR resume_id = $id")
      .get({ $id: sessionId }) as { path: string } | null;
    return row?.path ?? null;
  } finally {
    db.close();
  }
}

/**
 * Peak of the last N usage readings — the last record can be a zeroed failed turn, so we take
 * the max over the tail rather than strictly the last. Reflects the current working-set size.
 */
function peakContextTokens(path: string): number | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const readings: number[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let rec: { message?: { usage?: Record<string, number | undefined> } };
    try { rec = JSON.parse(line); } catch { continue; }
    const usage = rec.message?.usage ?? {};
    const it = usage.input_tokens;
    if (it) {
      readings.push(it + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0));
    }
  }
  if (readings.length === 0) return null;
  return Math.max(...readings.slice(-40));
}

function assess(tokens: number | null, limit: number): { status: Assessment["status"]; pct: number | null; directive: string } {
  if (tokens === null) {
    return { status: "UNKNOWN", pct: null, directive: "could not read context size (transcript not found)" };
  }
  const pct = Math.round((tokens / limit) * 100);
  if (pct >= CRIT_PCT) {
    return {
      status: "CRITICAL",
      pct,
      directive:
        "CONTEXT CRITICAL — run /compact NOW, before routing this tick. Your durable state is external " +
        "(read fresh next tick), so a post-compact session loses NOTHING. Compact first, then continue.",
    };
  }
  if (pct >= WARN_PCT) {
    return {
      status: "WARN",
      pct,
      directive:
        "CONTEXT WARN — finish this tick, then run /compact before the next one. Approaching the input " +
        `ceiling; do not let it reach ${CRIT_PCT}%.`,
    };
  }
  return { status: "OK", pct, directive: "context healthy" };
}

export function contextCheckCommand(args: string[]): number {
  const wantJson = args.includes("--json");
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    const msg = "CLAUDE_CODE_SESSION_ID not set (context-check must run inside a Claude Code session)";
    if (wantJson) {
      console.log(JSON.stringify({ status: "UNKNOWN", pct: null, tokens: null, directive: msg, transcript: null }));
    } else {
      console.log(`context: UNKNOWN — ${msg}`);
    }
    return 0;
  }
  const limit = Number(process.env.CCS_CONTEXT_LIMIT) || CONTEXT_LIMIT;
  const path = findTranscriptPath(sessionId);
  const tokens = path ? peakContextTokens(path) : null;
  const a = assess(tokens, limit);
  const result: Assessment = {
    status: a.status,
    pct: a.pct,
    tokens,
    directive: a.directive,
    transcript: path,
  };
  if (wantJson) {
    console.log(JSON.stringify(result));
  } else {
    const pctStr = result.pct !== null ? `${result.pct}%` : "?";
    console.log(`context: ${result.status} (${pctStr}) — ${result.directive}`);
  }
  return 0;
}
