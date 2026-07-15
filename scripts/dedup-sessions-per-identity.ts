#!/usr/bin/env bun
/**
 * For each identity, keep the NEWEST attached session and archive every other one.
 *
 * "Newest" is MRU by `catalogue.updated_at`, falling back to session_id for a stable tiebreak
 * (matches sessionsForRole's MRU_ORDER and ADR-0073's prefer-newest supersede rule). Only
 * touches sessions where `archived=0` — completed or already-archived rows stay put.
 *
 * ADR-0089 safety: writes go through `setArchived` (per-session flag). The identity itself is
 * NOT touched — this is a per-session cleanup, not a lifecycle transition. A `meta.dedup_reason`
 * pointer records WHY (superseded via dedup, distinguishable from hand-archived rows).
 *
 * Dry-run by default. Pass --apply to write. Pass --identity=<key> to scope to one identity.
 */
import { openCatalogue, setArchived } from "../src/catalogue/db.ts";
import { setMeta } from "../src/catalogue/db.ts";
import { runtimeRoot } from "../src/paths.ts";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const only = process.argv.find((a) => a.startsWith("--identity="))?.slice("--identity=".length);
const NOW = new Date().toISOString();
const catPath = join(runtimeRoot(), "cache", "catalogue.db");
const cat = openCatalogue(catPath);

interface Row { session_id: string; identity_key: string; updated_at: string | null; archived: number }

const rowsQ = only
  ? cat.query("SELECT session_id, identity_key, updated_at, archived FROM catalogue WHERE identity_key = $k").all({ $k: only })
  : cat.query("SELECT session_id, identity_key, updated_at, archived FROM catalogue WHERE identity_key IS NOT NULL").all();
const rows = rowsQ as Row[];

// group by identity
const byIdent = new Map<string, Row[]>();
for (const r of rows) {
  const arr = byIdent.get(r.identity_key) ?? [];
  arr.push(r);
  byIdent.set(r.identity_key, arr);
}

// MRU sort (matches sessionsForRole's ORDER BY updated_at DESC NULLS LAST, session_id).
// Nulls sort AFTER real timestamps — a row with a real updated_at always beats a null one.
function cmpNewestFirst(a: Row, b: Row): number {
  const au = a.updated_at, bu = b.updated_at;
  if (au && bu) return au < bu ? 1 : au > bu ? -1 : a.session_id.localeCompare(b.session_id);
  if (au && !bu) return -1;
  if (!au && bu) return 1;
  return a.session_id.localeCompare(b.session_id);
}

let kept = 0, planned = 0;
const plan: Array<{ ident: string; keep: string; archive: string[] }> = [];
for (const [ident, group] of byIdent) {
  // IDEMPOTENCY: pick the keeper from ACTIVE rows only. setArchived bumps
  // updated_at, so a row archived on a previous run would look "newer" than
  // active peers and would incorrectly become the next keeper — flipping the
  // dedup direction and never converging.
  const active = group.filter((r) => r.archived === 0);
  if (active.length <= 1) continue; // 0 or 1 active row → nothing to dedup
  active.sort(cmpNewestFirst);
  const [keeper, ...rest] = active;
  if (!keeper) continue; // unreachable — active.length > 1 above
  plan.push({ ident, keep: keeper.session_id, archive: rest.map((r) => r.session_id) });
  kept++;
  planned += rest.length;
}

console.log(`\nDedup plan (${APPLY ? "APPLYING" : "DRY-RUN"}):`);
console.log(`  identities scanned:        ${byIdent.size}`);
console.log(`  identities with dupes:     ${kept}`);
console.log(`  sessions to archive:       ${planned}`);
if (only) console.log(`  scope: identity_key = ${only}`);
console.log();
for (const p of plan.slice(0, 20)) {
  console.log(`  ${p.ident}`);
  console.log(`    keep    : ${p.keep.slice(0, 8)}…`);
  for (const sid of p.archive) console.log(`    archive : ${sid.slice(0, 8)}…`);
}
if (plan.length > 20) console.log(`  … and ${plan.length - 20} more identities`);

if (!APPLY) {
  console.log(`\n(dry run — pass --apply to write)`);
  process.exit(0);
}

let archived = 0;
cat.exec("BEGIN");
try {
  for (const p of plan) {
    for (const sid of p.archive) {
      setArchived(cat, sid, true, NOW);
      setMeta(cat, sid, "dedup_reason", `superseded_by:${p.keep}`, NOW);
      archived++;
    }
  }
  cat.exec("COMMIT");
} catch (e) {
  cat.exec("ROLLBACK");
  throw e;
}

console.log(`\nDone: archived ${archived} session(s) across ${plan.length} identity/identities.`);
