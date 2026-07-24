import { existsSync } from "node:fs";
import { openIndex } from "../index/schema.ts";
import { sessionById } from "../index/index.ts";
import { openCatalogue } from "../catalogue/db.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { loadEnrichmentLocations, LOCATION_REGISTRY_PATH } from "./locations.ts";
import { enrichCandidates, enrichOne, sweep } from "./enrich.ts";
import { stalenessLabel } from "./staleness.ts";

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
  const all = enrichCandidates(index, catalogue);
  const shown = limit ? all.slice(0, limit) : all;
  if (asJson) {
    console.log(JSON.stringify(
      shown.map((c) => ({
        sessionId: c.row.sessionId,
        title: c.row.title,
        reason: c.reason,
        messagesSince: c.messagesSince,
      })),
      null,
      2,
    ));
    return 0;
  }
  if (shown.length === 0) {
    console.log("Nothing stale — every top-level session has a current enrichment.");
    return 0;
  }
  console.log(`${all.length} stale session${all.length === 1 ? "" : "s"}${limit && all.length > shown.length ? ` (showing ${shown.length})` : ""}:`);
  for (const candidate of shown) {
    const since = candidate.reason === "never-enriched"
      ? "never enriched"
      : stalenessLabel(candidate.messagesSince) ?? candidate.reason;
    console.log(`  ${candidate.row.sessionId.slice(0, 8)}…  ${since.padEnd(24)}  ${candidate.row.title}`);
  }
  return 0;
}

async function runSweep(
  index: ReturnType<typeof openIndex>,
  catalogue: ReturnType<typeof openCatalogue>,
  limit: number | undefined,
  concurrency: number | undefined,
  asJson: boolean,
): Promise<number> {
  warnIfNoRegistry();
  const total = enrichCandidates(index, catalogue).length;
  if (total === 0) {
    if (asJson) console.log(JSON.stringify({ enriched: 0, failed: 0, remaining: 0 }));
    else console.log("Nothing stale.");
    return 0;
  }
  if (!asJson) process.stdout.write(`Enriching ${limit ? Math.min(limit, total) : total} of ${total} stale sessions… `);
  const stats = await sweep(index, catalogue, {
    limit,
    concurrency,
    onProgress: asJson ? undefined : (done, count) => {
      process.stdout.write(`\rEnriching… ${done}/${count}`);
    },
  });
  if (asJson) {
    console.log(JSON.stringify(stats));
  } else {
    process.stdout.write("\r");
    console.log(`Enriched ${stats.enriched}, failed ${stats.failed}${stats.remaining > 0 ? `, ${stats.remaining} left for the next run` : ""}.`);
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
  const row = sessionById(index, sessionId);
  if (!row) {
    console.error(`ccs enrich: ${sessionId.slice(0, 8)}… is not in the index (run \`ccs reindex\`).`);
    return 1;
  }
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
  console.log(`${row.title}  [${row.sessionId.slice(0, 8)}…]`);
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
 * The location registry is optional, but its absence silently degrades cwd analysis to free-text
 * guesses — worth one line so a machine missing the file doesn't quietly produce worse output
 * than a machine that has it.
 */
function warnIfNoRegistry(): void {
  if (loadEnrichmentLocations().length === 0) {
    console.warn(`ccs enrich: no location registry at ${LOCATION_REGISTRY_PATH()} — cwd suggestions will be unconstrained.`);
  }
}
