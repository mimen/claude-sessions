/**
 * Freshness contract entrypoint (ADR-0077 §Freshness): after ccs writes state that would change
 * a session's composed board row (stage / status / meta.stage-relevant keys), invoke the cluster's
 * composer synchronously for that identity so consumers reading board.json see the new state
 * BEFORE the next scheduled tick. Otherwise the sidebar paints stale immediately after an
 * approval, defeating the point of the composed view.
 *
 * Non-fatal: recompose failures log at warn but never fail the write. The next scheduled tick's
 * whole-board recompose catches up. Skip on dry-run.
 */
import { spawnSync } from "node:child_process";
import { openCatalogue, getRow, identityKeyOf } from "../catalogue/db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { readClusterManifest } from "../cluster/manifest.ts";
import { boardIndex } from "./indexer.ts";
import { runDefaultComposer } from "./default-composer.ts";

export interface RecomposeOpts {
  /** Skip when true (respects --dry-run on the calling command). */
  dryRun?: boolean;
  /** Where to log warnings; defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

/**
 * Trigger a synchronous single-identity recompose for whichever cluster this session belongs to.
 * No-ops silently if the session isn't in the catalogue, isn't in a cluster, has no identity, or
 * the cluster has no composer entry. Logs a warn on composer failure.
 */
export function recomposeForSession(sessionId: string, opts: RecomposeOpts = {}): void {
  if (opts.dryRun) return;
  const warn = opts.onWarn ?? ((m: string) => console.warn(`ccs board recompose: ${m}`));

  let cluster: string | null = null;
  let identity: string | null = null;
  try {
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    try {
      const row = getRow(db, sessionId);
      if (!row) return;
      cluster = row.cluster ?? null;
      identity = identityKeyOf(row);
    } finally {
      db.close();
    }
  } catch (e) {
    warn(`catalogue read failed: ${(e as Error).message}`);
    return;
  }

  if (!cluster || !identity) return;

  const manifestResult = readClusterManifest(cluster);
  const composerPath = manifestResult.ok ? manifestResult.value.boardPath : null;

  if (!composerPath) {
    // Fall back to the default composer for clusters that haven't declared a `board` entry.
    try {
      runDefaultComposer(cluster, { identity });
    } catch (e) {
      warn(`default composer failed for ${cluster}:${identity}: ${(e as Error).message}`);
    }
    // Invalidate the indexer so the next read picks up the fresh row.
    boardIndex(cluster).refresh();
    return;
  }

  // Cluster-provided composer. Invoke with `--identity <key> --write`; block until it exits.
  const r = spawnSync("python3", [composerPath, "--identity", identity, "--write"], {
    stdio: "ignore",
    timeout: 15_000,
  });
  if (r.status !== 0) {
    warn(`composer ${composerPath} exited ${r.status} for ${identity}`);
  }
  boardIndex(cluster).refresh();
}
