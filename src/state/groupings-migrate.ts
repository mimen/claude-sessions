import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";
import { getGrouping, upsertGrouping } from "./groupings-db.ts";

/**
 * ADR-0089 step 4: one-time migration of ~/.ccs/clusters/<c>/cluster/groupings.json files
 * into the `groupings` table. Idempotent — running twice does nothing on the second pass
 * because rows already exist.
 *
 * After a successful migration, the source file is renamed to `groupings.json.migrated` so
 * the operator can verify + remove it, but the file is never deleted here.
 *
 * The migration assigns `role = "pr-agent"` for pr-watch groupings by default (that's the
 * only fleet role using groupings today). A future cluster with multiple fleet roles that
 * share groupings will need to route by identity → role lookup, but for now the pr-watch
 * case is direct.
 */

const DEFAULT_ROLE_BY_CLUSTER: Record<string, string> = {
  "pr-watch": "pr-agent",
};

interface GroupingsJsonDoc {
  data?: Record<string, {
    label?: string | null;
    url?: string | null;
    shortName?: string | null;
    notes?: string[];
    updatedAt?: string | null;
  }>;
  // The old file could also be un-enveloped (raw {groupingId: Grouping} map).
  [key: string]: unknown;
}

/** Migrate every ~/.ccs/clusters/<c>/cluster/groupings.json into the groupings table. */
export function migrateGroupingsJsonToDb(db: Database, runtimeRoot = ccsRuntimeRoot()): number {
  const clustersDir = join(runtimeRoot, "clusters");
  if (!existsSync(clustersDir)) return 0;
  let migrated = 0;
  for (const cluster of readdirSync(clustersDir)) {
    const clusterPath = join(clustersDir, cluster);
    if (!statSync(clusterPath).isDirectory()) continue;
    const jsonPath = join(clusterPath, "cluster", "groupings.json");
    if (!existsSync(jsonPath)) continue;
    let doc: GroupingsJsonDoc;
    try {
      doc = JSON.parse(readFileSync(jsonPath, "utf8"));
    } catch {
      continue; // unreadable file — leave it for the operator to inspect
    }
    const groupings = doc.data ?? (doc as Record<string, unknown>);
    if (!groupings || typeof groupings !== "object") continue;
    const role = DEFAULT_ROLE_BY_CLUSTER[cluster] ?? "pr-agent";
    for (const [groupingId, g] of Object.entries(groupings as Record<string, unknown>)) {
      if (typeof g !== "object" || g === null) continue;
      const grouping = g as {
        label?: string | null;
        url?: string | null;
        shortName?: string | null;
        notes?: string[];
        updatedAt?: string | null;
      };
      // Idempotent: skip if a row already exists.
      if (getGrouping(db, groupingId)) continue;
      const now = grouping.updatedAt ?? new Date().toISOString();
      upsertGrouping(
        db,
        groupingId,
        {
          cluster,
          role,
          label: grouping.label ?? null,
          url: grouping.url ?? null,
          shortName: grouping.shortName ?? null,
        },
        now,
      );
      // Notes carry over: bypass the append API for bulk insertion.
      if (Array.isArray(grouping.notes) && grouping.notes.length > 0) {
        db.query("UPDATE groupings SET notes = $n WHERE grouping_id = $id").run({
          $n: JSON.stringify(grouping.notes),
          $id: groupingId,
        });
      }
      migrated++;
    }
    // Rename the file (never delete) so the operator can verify + rm manually.
    try {
      renameSync(jsonPath, `${jsonPath}.migrated`);
    } catch {
      // If rename fails (permissions, whatever), the next boot will re-attempt the migration.
      // getGrouping's exists-check makes that idempotent, so no rows will be duplicated.
    }
  }
  return migrated;
}
