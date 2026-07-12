import { openCatalogue, getAll, setWorkUnitId, lifecycleOf } from "./db.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { resolveWorkUnit } from "./resolve-work-unit.ts";

/**
 * `ccs backfill-work-units [--dry-run]` — one-time migration for ADR-0057.
 *
 * The work-unit ENTITY lives in cluster-state JSON, not the catalogue, so the backfill can't be a
 * SQL migration. This command scans every catalogue row that has a cluster + an anchor (PR/GUS)
 * but no work_unit_id yet, resolve-or-mints its work-unit (find-or-create by anchor, so all
 * sessions of one PR converge to a single id), and sets the FK. Idempotent: a row that already has
 * a work_unit_id is skipped, and re-running mints nothing new (find-or-create returns the same id).
 * Retired rows are skipped (they don't need a live entity). Best-effort per row — a store failure
 * on one row is logged and doesn't abort the pass.
 */
export function backfillWorkUnits(args: string[]): number {
  const dryRun = args.includes("--dry-run");
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  let scanned = 0, backfilled = 0, skipped = 0, failed = 0;
  const now = new Date().toISOString();
  try {
    for (const [sid, row] of getAll(db)) {
      scanned++;
      if (row.workUnitId) { skipped++; continue; }              // already linked
      if (!row.cluster) { skipped++; continue; }                // work-unit is cluster-scoped
      const lc = lifecycleOf(row);
      if (lc === "completed" || lc === "archived") { skipped++; continue; } // retired
      const hasAnchor = !!row.gusWork || (row.prNumber != null && !!row.prRepo);
      if (!hasAnchor) { skipped++; continue; }                  // anchorless → nothing to key on
      if (dryRun) { backfilled++; continue; }
      try {
        const wuId = resolveWorkUnit(
          row.cluster,
          { prRepo: row.prRepo, prNumber: row.prNumber, gusWork: row.gusWork },
          now,
          "backfill",
        );
        setWorkUnitId(db, sid, wuId, now);
        backfilled++;
      } catch (e) {
        failed++;
        console.error(`  ✗ ${sid.slice(0, 8)}: ${(e as Error).message}`);
      }
    }
  } finally {
    db.close();
  }
  const verb = dryRun ? "would backfill" : "backfilled";
  console.log(`ccs backfill-work-units: ${verb} ${backfilled}, skipped ${skipped}, scanned ${scanned}${failed ? `, ${failed} failed` : ""}`);
  return failed > 0 ? 1 : 0;
}
