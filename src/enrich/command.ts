import { existsSync } from "node:fs";
import { openIndex } from "../index/schema.ts";
import { sessionById, type SessionRow } from "../index/index.ts";
import { err, ok, type Result } from "../result.ts";
import { openCatalogue } from "../catalogue/db.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { loadEnrichmentLocations, LOCATION_REGISTRY_PATH } from "./locations.ts";
import { enrichOne, enrichSurvey, sweep } from "./enrich.ts";
import { stalenessLabel } from "./staleness.ts";

/** Terminal dim, kept local — this file is the only place ccs enrich styles anything. */
const fgDim = (text: string): string => `\x1b[2m${text}\x1b[0m`;

/**
 * `ccs enrich` — generate the cached per-session summaries that make a large store legible.
 *
 * Three modes, one command:
 *   ccs enrich [<id>|.]        one session, now, regardless of staleness
 *   ccs enrich --sweep         every stale session, bounded and concurrent
 *   ccs enrich --list          what the sweep WOULD do, without calling the model
 *
 * `--list` exists because the sweep is the thing a scheduled job runs unattended: being able to
 * ask "what do you think is stale right now" without spending calls is how you debug a cadence
 * that has gone wrong.
 */

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function positiveInt(raw: string | undefined, label: string): number | undefined | null {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`ccs enrich: --${label} expects a positive integer (got "${raw}")`);
    return null;
  }
  return value;
}

export async function enrichCommand(args: string[]): Promise<number> {
  const wantsSweep = args.includes("--sweep");
  const wantsList = args.includes("--list");
  const asJson = args.includes("--json");

  if (wantsSweep && wantsList) {
    console.error("ccs enrich: pass --sweep or --list, not both");
    return 1;
  }

  const limit = positiveInt(flagValue(args, "--limit"), "limit");
  if (limit === null) return 1;
  const concurrency = positiveInt(flagValue(args, "--concurrency"), "concurrency");
  if (concurrency === null) return 1;

  if (!existsSync(DB_PATH())) {
    console.error("ccs enrich: no session index yet — run `ccs reindex` first.");
    return 1;
  }

  ensureDataDir();
  const index = openIndex(DB_PATH());
  const catalogue = openCatalogue(CATALOGUE_PATH());
  try {
    if (wantsList) return listStale(index, catalogue, limit, asJson);
    if (wantsSweep) return await runSweep(index, catalogue, limit, concurrency, asJson);
    return await runOne(index, catalogue, args, asJson);
  } finally {
    index.close();
    catalogue.close();
  }
}

function listStale(
  index: ReturnType<typeof openIndex>,
  catalogue: ReturnType<typeof openCatalogue>,
  limit: number | undefined,
  asJson: boolean,
): number {
  const { candidates: all, exhausted } = enrichSurvey(index, catalogue);
  const shown = limit ? all.slice(0, limit) : all;
  if (asJson) {
    console.log(JSON.stringify(
      {
        stale: shown.map((c) => ({
          sessionId: c.row.sessionId,
          title: c.row.title,
          reason: c.reason,
          messagesSince: c.messagesSince,
        })),
        exhausted: exhausted.map((e) => ({ sessionId: e.row.sessionId, title: e.row.title, attempts: e.attempts })),
      },
      null,
      2,
    ));
    return 0;
  }
  if (shown.length === 0) {
    console.log("Nothing stale — every top-level session has a current enrichment.");
    reportExhausted(exhausted);
    return 0;
  }
  console.log(`${all.length} stale session${all.length === 1 ? "" : "s"}${limit && all.length > shown.length ? ` (showing ${shown.length})` : ""}:`);
  for (const candidate of shown) {
    const since = candidate.reason === "never-enriched"
      ? "never enriched"
      : stalenessLabel(candidate.messagesSince) ?? candidate.reason;
    console.log(`  ${candidate.row.sessionId.slice(0, 8)}…  ${since.padEnd(24)}  ${candidate.row.title}`);
  }
  reportExhausted(exhausted);
  return 0;
}

/**
 * Name the sessions that have fallen out of the sweep entirely.
 *
 * A session at the attempt cap is skipped forever and looks exactly like one that is up to date,
 * so a transient outage can quietly cost you coverage with nothing to show for it. `ccs enrich
 * <id>` ignores the cap and resets it on success, which is why the hint is worth printing.
 */
function reportExhausted(exhausted: readonly { row: { sessionId: string; title: string }; attempts: number }[]): void {
  if (exhausted.length === 0) return;
  console.log(`\n${exhausted.length} session${exhausted.length === 1 ? "" : "s"} excluded — attempt budget spent:`);
  for (const item of exhausted.slice(0, 10)) {
    console.log(`  ${item.row.sessionId.slice(0, 8)}…  ${String(item.attempts).padEnd(24)}  ${item.row.title}`);
  }
  console.log("  retry one with: ccs enrich <id>   (ignores the cap, resets it on success)");
}

async function runSweep(
  index: ReturnType<typeof openIndex>,
  catalogue: ReturnType<typeof openCatalogue>,
  limit: number | undefined,
  concurrency: number | undefined,
  asJson: boolean,
): Promise<number> {
  warnIfNoRegistry();
  const total = enrichSurvey(index, catalogue).candidates.length;
  if (total === 0) {
    if (asJson) console.log(JSON.stringify({ enriched: 0, failed: 0, remaining: 0 }));
    else console.log("Nothing stale.");
    return 0;
  }
  if (!asJson) process.stdout.write(`Enriching ${limit ? Math.min(limit, total) : total} of ${total} stale sessions… `);
  const stats = await sweep(index, catalogue, {
    limit,
    concurrency,
    // Always to stderr, in both modes: this is the only record a scheduled run leaves behind.
    onFailure: (sessionId, error) => {
      // Truncated: a malformed generation can echo an entire garbled tool call into the message,
      // and one such line can bury a whole run's worth of log.
      const detail = error.message.replace(/\s+/g, " ").slice(0, 200);
      console.error(`ccs enrich: ${sessionId.slice(0, 8)}… failed: ${detail}`);
    },
    onProgress: asJson ? undefined : (done, count) => {
      process.stdout.write(`\rEnriching… ${done}/${count}`);
    },
  });
  if (asJson) {
    console.log(JSON.stringify(stats));
  } else {
    process.stdout.write("\r");
    console.log(`Enriched ${stats.enriched}, failed ${stats.failed}${stats.remaining > 0 ? `, ${stats.remaining} left for the next run` : ""}.`);
    if (stats.abortedReason) {
      console.log(`Stopped early — the gateway is unavailable: ${stats.abortedReason.slice(0, 160)}`);
    }
  }
  // A sweep in which everything failed is a broken gateway or a bad key, not a quiet no-op —
  // exit non-zero so a scheduled run surfaces in launchd's logs instead of looking healthy.
  return stats.enriched === 0 && stats.failed > 0 ? 1 : 0;
}

async function runOne(
  index: ReturnType<typeof openIndex>,
  catalogue: ReturnType<typeof openCatalogue>,
  args: string[],
  asJson: boolean,
): Promise<number> {
  const arg = args.find((a) => !a.startsWith("--"));
  const sessionId = !arg || arg === "." || arg === "self"
    ? process.env.CLAUDE_CODE_SESSION_ID ?? null
    : arg;
  if (!sessionId) {
    console.error("No session id (pass one, or run inside a Claude session for `.`).");
    return 1;
  }
  const resolved = resolveIndexedSession(index, sessionId);
  if (!resolved.ok) {
    console.error(`ccs enrich: ${resolved.error.message}`);
    return 1;
  }
  const row = resolved.value;
  warnIfNoRegistry();
  const result = await enrichOne(catalogue, index, row, loadEnrichmentLocations());
  if (!result.ok) {
    console.error(`ccs enrich: ${result.error.message}`);
    return 1;
  }
  if (asJson) {
    console.log(JSON.stringify(result.value, null, 2));
    return 0;
  }
  const e = result.value;
  // Show the enriched title, not the indexed one — it is usually the visible improvement.
  console.log(`${e.title}  [${row.sessionId.slice(0, 8)}…]`);
  if (e.title !== row.title) console.log(fgDim(`was: ${row.title}`));
  console.log(e.summary);
  if (e.outstanding) console.log(`open: ${e.outstanding}`);
  console.log(`recommend: ${e.recommendation} — ${e.reason}`);
  if (e.junk) console.log("junk: this session was never worth starting");
  if (!e.cwdCorrect) {
    const where = e.suggestedLocation || e.suggestedCwd || "(unspecified)";
    console.log(`cwd: ${row.cwd ?? "(unknown)"} → should be ${where}`);
  }
  return 0;
}

/**
 * Resolve an id or a unique short prefix to an indexed session.
 *
 * Prefixes matter because `--list` prints the same 8-character form every other ccs surface
 * shows, and a command whose own output can't be pasted back into it is a papercut on every use.
 * An ambiguous prefix is refused rather than guessed — enrichment writes to whichever session it
 * picks, so silently choosing one of two candidates would corrupt a row the user never named.
 */
function resolveIndexedSession(index: ReturnType<typeof openIndex>, id: string): Result<SessionRow> {
  const exact = sessionById(index, id);
  if (exact) return ok(exact);

  const matches = index
    .query("SELECT session_id FROM sessions WHERE session_id LIKE $prefix LIMIT 5")
    .all({ $prefix: `${id}%` }) as { session_id: string }[];
  if (matches.length === 1) {
    const row = sessionById(index, matches[0]!.session_id);
    if (row) return ok(row);
  }
  if (matches.length > 1) {
    return err(new Error(
      `"${id}" matches ${matches.length} sessions (${matches.map((m) => m.session_id.slice(0, 12)).join(", ")}) — use a longer prefix.`,
    ));
  }
  return err(new Error(`${id.slice(0, 8)}… is not in the index (run \`ccs reindex\`).`));
}

/**
 * The location registry is optional, but its absence silently degrades cwd analysis to free-text
 * guesses — worth one line so a machine missing the file doesn't quietly produce worse output
 * than a machine that has it.
 */
function warnIfNoRegistry(): void {
  if (loadEnrichmentLocations().length === 0) {
    console.warn(`ccs enrich: no location registry at ${LOCATION_REGISTRY_PATH()} — cwd suggestions will be unconstrained.`);
  }
}
