#!/usr/bin/env bun
/**
 * ADR-0089 recovery: attach ambient Claude sessions to core-role identities by cwd.
 *
 * Reads $CCS_ROOT/cache/index.db + $CCS_ROOT/cache/catalogue.db, finds sessions whose cwd
 * is under `<ccs-config>/clusters/<cluster>/roles/<role>/...`, ensures a catalogue row
 * exists, ensures the `<cluster>:<role>` core identity exists, and links the session to it.
 *
 * Only touches sessions that are currently unattached (identity_key IS NULL) OR missing a
 * catalogue row entirely. Never overwrites an existing identity_key.
 *
 * Dry-run by default. Pass --apply to write.
 */
import { openCatalogue, ensureRow } from "../src/catalogue/db.ts";
import { mintIdentity } from "../src/catalogue/identities.ts";
import { openIndex } from "../src/index/schema.ts";
import { ccsConfigRoot } from "../src/roles/role-files.ts";
import { runtimeRoot } from "../src/paths.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const NOW = new Date().toISOString();

const cfgRoot = ccsConfigRoot();
const idxPath = join(runtimeRoot(), "cache", "index.db");
const catPath = join(runtimeRoot(), "cache", "catalogue.db");

const idx = openIndex(idxPath);
const cat = openCatalogue(catPath);

// role-dir pattern: <cfgRoot>/clusters/<cluster>/roles/<role>[/...]
const rolesPrefix = join(cfgRoot, "clusters") + "/";

const rows = idx.query(
  `SELECT s.session_id, s.cwd
   FROM sessions s
   WHERE s.cwd LIKE $prefix`
).all({ $prefix: `${rolesPrefix}%` }) as Array<{ session_id: string; cwd: string }>;

const candidates: Array<{ sessionId: string; cluster: string; role: string }> = [];
for (const r of rows) {
  const rest = r.cwd.slice(rolesPrefix.length); // "<cluster>/roles/<role>/..." or "<cluster>/roles/<role>"
  const parts = rest.split("/");
  if (parts.length < 3 || parts[1] !== "roles") continue;
  const cluster = parts[0];
  const role = parts[2];
  if (!cluster || !role) continue;
  // sanity: role must actually exist in the config tree
  if (!existsSync(join(cfgRoot, "clusters", cluster, "roles", role, "role.toml"))) continue;
  candidates.push({ sessionId: r.session_id, cluster, role });
}

// Filter down to sessions that need attaching:
//   - no catalogue row, OR
//   - catalogue row with null identity_key
const getCat = cat.query("SELECT identity_key FROM catalogue WHERE session_id = $sid");
const needs: typeof candidates = [];
for (const c of candidates) {
  const row = getCat.get({ $sid: c.sessionId }) as { identity_key: string | null } | null;
  if (row === null) needs.push(c); // no catalogue row
  else if (row.identity_key === null) needs.push(c); // catalogue row but unattached
}

// Group for reporting
const perKey = new Map<string, number>();
for (const c of needs) {
  const k = `${c.cluster}:${c.role}`;
  perKey.set(k, (perKey.get(k) ?? 0) + 1);
}

console.log(`\nBackfill plan (${APPLY ? "APPLYING" : "DRY-RUN"}):`);
console.log(`  candidates scanned:       ${candidates.length}`);
console.log(`  sessions needing attach:  ${needs.length}`);
console.log(`  identities to touch:`);
const sortedKeys = [...perKey.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, n] of sortedKeys) console.log(`    ${k}  ← ${n} session(s)`);

if (!APPLY) {
  console.log(`\n(dry run — pass --apply to write)`);
  process.exit(0);
}

const link = cat.query(
  "UPDATE catalogue SET identity_key = $k, updated_at = $now WHERE session_id = $sid"
);

let attached = 0;
let mintedIdentities = 0;
let createdRows = 0;

cat.exec("BEGIN");
try {
  for (const c of needs) {
    const key = `${c.cluster}:${c.role}`;
    // ensure identity
    if (mintIdentity(cat, key, { cluster: c.cluster, role: c.role }, NOW)) {
      mintedIdentities++;
    }
    // ensure catalogue row
    const existing = getCat.get({ $sid: c.sessionId });
    if (existing === null) {
      ensureRow(cat, c.sessionId, NOW);
      createdRows++;
    }
    link.run({ $k: key, $now: NOW, $sid: c.sessionId });
    attached++;
  }
  cat.exec("COMMIT");
} catch (e) {
  cat.exec("ROLLBACK");
  throw e;
}

console.log(`\nDone:`);
console.log(`  new identities minted:    ${mintedIdentities}`);
console.log(`  catalogue rows created:   ${createdRows}`);
console.log(`  sessions attached:        ${attached}`);
