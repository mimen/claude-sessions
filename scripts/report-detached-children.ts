#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { DB_PATH } from "../src/paths.ts";
import {
  classifyHistoricalDetachedChildren,
  type CandidateRootSession,
} from "../src/cleanup/historical-detached-child-classifier.ts";

interface IndexRow {
  readonly session_id: string;
  readonly path: string;
  readonly cwd: string | null;
  readonly first_ts: string | null;
  readonly last_ts: string | null;
  readonly is_subagent: number;
  readonly cost_by_model: string;
}

interface Args {
  readonly since: string;
  readonly output: string | null;
  readonly indexPath: string;
}

function flagValue(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function parseArgs(args: readonly string[]): Args {
  return {
    since: flagValue(args, "--since") ?? "2026-07-12T00:00:00.000Z",
    output: flagValue(args, "--output"),
    indexPath: flagValue(args, "--index") ?? DB_PATH(),
  };
}

function observedModels(raw: string): string[] {
  try {
    return Object.keys(JSON.parse(raw) as Record<string, number>).sort();
  } catch {
    return [];
  }
}

function providerFor(models: readonly string[]): "claude" | "gpt" | null {
  const providers = new Set(
    models.map((model) => model.startsWith("gpt-") ? "gpt" : model.startsWith("claude-") ? "claude" : "other"),
  );
  if (providers.size !== 1 || providers.has("other")) return null;
  return providers.has("gpt") ? "gpt" : "claude";
}

async function entrypointFor(path: string): Promise<string | null> {
  try {
    const text = await Bun.file(path).text();
    const match = text.match(/"entrypoint"\s*:\s*"([^"]+)"/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function candidateFor(row: IndexRow): Promise<CandidateRootSession> {
  const models = observedModels(row.cost_by_model);
  return {
    sessionId: row.session_id,
    transcriptPath: row.path,
    cwd: row.cwd,
    entrypoint: await entrypointFor(row.path),
    provider: providerFor(models),
    model: models.length === 1 ? models[0]! : null,
    startedAt: row.first_ts,
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const sinceMs = Date.parse(args.since);
  if (Number.isNaN(sinceMs)) {
    console.error(`Invalid --since timestamp: ${args.since}`);
    return 2;
  }

  let db: Database;
  try {
    db = new Database(args.indexPath, { readonly: true });
  } catch (error) {
    console.error(`Cannot open CCS index at ${args.indexPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  try {
    const rows = db.query(
      `SELECT session_id, path, cwd, first_ts, last_ts, is_subagent, cost_by_model
       FROM sessions
       WHERE COALESCE(last_ts, first_ts, '') >= $since
       ORDER BY path, session_id`,
    ).all({ $since: new Date(sinceMs).toISOString() }) as IndexRow[];

    const missingTranscriptPaths = rows.map((row) => row.path).filter((path) => !existsSync(path)).sort();
    const readableRows = rows.filter((row) => existsSync(row.path));
    const parentTranscriptPaths = readableRows.map((row) => row.path).sort();
    const rootRows = readableRows.filter((row) => row.is_subagent === 0);
    const candidates = await Promise.all(rootRows.map(candidateFor));
    const classified = await classifyHistoricalDetachedChildren({ parentTranscriptPaths, candidates });
    if (!classified.ok) {
      console.error(JSON.stringify(classified.error));
      return 1;
    }

    const report = {
      ...classified.value,
      source: {
        since: new Date(sinceMs).toISOString(),
        indexPath: args.indexPath,
        missingTranscriptPaths,
      },
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (args.output) writeFileSync(args.output, json, "utf8");
    else process.stdout.write(json);
    return 0;
  } finally {
    db.close();
  }
}

process.exit(await main());
