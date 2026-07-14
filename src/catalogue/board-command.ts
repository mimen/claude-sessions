/**
 * `ccs board <cluster> [flags]` — cluster-composed per-worker truth view.
 *
 * The TOOL owns the *dispatch mechanism* (find the cluster's board composer, exec it, read/write
 * board.json). The CLUSTER owns the *policy* (what a "row" means, what checks compose into a truth
 * label, per-role vocabulary). Per ADR-0061/0077: tool = mechanism, cluster = policy.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readClusterManifest } from "../cluster/manifest.ts";
import { ccsConfigRoot } from "../roles/role-files.ts";
import { boardIndex } from "../board/indexer.ts";
import { runDefaultComposer } from "../board/default-composer.ts";
import { openCatalogue, identityKeyOf, getRow } from "./db.ts";
import { CATALOGUE_PATH } from "../paths.ts";

export function boardCommand(args: string[]): number {
  const cluster = args.find((a) => !a.startsWith("--"));
  if (!cluster) {
    console.error("usage: ccs board <cluster> [--json|--text|--identity <key>|--session <sid>|--recompose <key>|--recompose-all]");
    return 1;
  }
  if (args.includes("--identity")) {
    const identity = args[args.indexOf("--identity") + 1];
    if (!identity) {
      console.error("--identity requires a key");
      return 1;
    }
    return readIdentity(cluster, identity, args.includes("--text"));
  }
  if (args.includes("--session")) {
    const sid = args[args.indexOf("--session") + 1];
    if (!sid) {
      console.error("--session requires a session id");
      return 1;
    }
    return readSession(cluster, sid, args.includes("--text"));
  }
  if (args.includes("--recompose")) {
    const identity = args[args.indexOf("--recompose") + 1];
    if (!identity) {
      console.error("--recompose requires a key");
      return 1;
    }
    return recompose(cluster, identity);
  }
  if (args.includes("--recompose-all")) {
    return recomposeAll(cluster);
  }
  const format = args.includes("--json") ? "--json" : "--text";
  const idx = boardIndex(cluster);
  const rows = idx.rows();
  if (format === "--json") {
    console.log(JSON.stringify({ rows }, null, 2));
  } else {
    for (const row of rows) {
      const pills = row.pills.map((p) => p.label).join(" · ");
      const alerts = row.alerts.length > 0 ? ` [${row.alerts.map((a) => a.name).join(", ")}]` : "";
      console.log(`${row.identity}: ${pills}${alerts}`);
      if (row.description) console.log(`  ${row.description}`);
    }
  }
  return 0;
}

function readIdentity(cluster: string, identity: string, text: boolean): number {
  const idx = boardIndex(cluster);
  const row = idx.byIdentity(identity);
  if (!row) {
    console.error(`no row for identity "${identity}"`);
    return 1;
  }
  if (text) {
    const pills = row.pills.map((p) => p.label).join(" · ");
    const alerts = row.alerts.length > 0 ? ` [${row.alerts.map((a) => a.name).join(", ")}]` : "";
    console.log(`${row.identity}: ${pills}${alerts}`);
    if (row.description) console.log(`  ${row.description}`);
  } else {
    console.log(JSON.stringify(row, null, 2));
  }
  return 0;
}

function readSession(cluster: string, sessionId: string, text: boolean): number {
  const idx = boardIndex(cluster);
  const hit = idx.bySession(sessionId);
  if (!hit) {
    console.error(`session "${sessionId}" has no identity or no board row`);
    return 1;
  }
  const row = hit.row;
  if (text) {
    const pills = row.pills.map((p) => p.label).join(" · ");
    const alerts = row.alerts.length > 0 ? ` [${row.alerts.map((a) => a.name).join(", ")}]` : "";
    console.log(`${row.identity}: ${pills}${alerts}`);
    if (row.description) console.log(`  ${row.description}`);
  } else {
    console.log(JSON.stringify(row, null, 2));
  }
  return 0;
}

function recompose(cluster: string, identity: string): number {
  const manifest = readClusterManifest(cluster);
  if (!manifest.ok) {
    console.warn(`cluster manifest not found, falling back to default composer`);
    runDefaultComposer(cluster, { identity });
    boardIndex(cluster).refresh();
    const row = boardIndex(cluster).byIdentity(identity);
    if (!row) {
      console.error(`default composer failed to produce row for "${identity}"`);
      return 1;
    }
    console.log(JSON.stringify(row, null, 2));
    return 0;
  }
  if (!manifest.value.boardPath) {
    runDefaultComposer(cluster, { identity });
    boardIndex(cluster).refresh();
    const row = boardIndex(cluster).byIdentity(identity);
    if (!row) {
      console.error(`default composer failed to produce row for "${identity}"`);
      return 1;
    }
    console.log(JSON.stringify(row, null, 2));
    return 0;
  }
  if (!existsSync(manifest.value.boardPath)) {
    console.error(`board composer at "${manifest.value.boardPath}" does not exist`);
    return 1;
  }
  const stateDir = join(process.env.HOME ?? "", ".ccs", "clusters", cluster, "cluster");
  const r = spawnSync(manifest.value.boardPath, ["--identity", identity, "--write", stateDir], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) return r.status ?? 1;
  boardIndex(cluster).refresh();
  const row = boardIndex(cluster).byIdentity(identity);
  if (!row) {
    console.error(`composer succeeded but no row found for "${identity}"`);
    return 1;
  }
  console.log(JSON.stringify(row, null, 2));
  return 0;
}

function recomposeAll(cluster: string): number {
  const manifest = readClusterManifest(cluster);
  if (!manifest.ok) {
    console.warn(`cluster manifest not found, falling back to default composer`);
    runDefaultComposer(cluster);
    return 0;
  }
  if (!manifest.value.boardPath) {
    runDefaultComposer(cluster);
    return 0;
  }
  if (!existsSync(manifest.value.boardPath)) {
    console.error(`board composer at "${manifest.value.boardPath}" does not exist`);
    return 1;
  }
  const stateDir = join(process.env.HOME ?? "", ".ccs", "clusters", cluster, "cluster");
  const r = spawnSync(manifest.value.boardPath, ["--write", stateDir], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return r.status ?? 1;
}
