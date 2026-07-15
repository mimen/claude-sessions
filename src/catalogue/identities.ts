import type { Database } from "bun:sqlite";
import { deriveIdentityKey } from "./db.ts";
import { loadIdentitySchema, tableSlug } from "./identity-schema.ts";
import { ccsConfigRoot } from "../roles/role-files.ts";
import { join } from "node:path";
import { existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";

/**
 * ADR-0089 step 6: identity CRUD + per-role attribute join.
 *
 * Every identity has a universal row in `identities` (cluster, role, kind, grouping_id,
 * stage, status_line, meta, lifecycle) plus, for fleet roles, a matching row in
 * `identity_<role_slug>` with role-declared attributes (pr_repo, pr_number, gus_work, …).
 *
 * Reads join both tables and return a merged view. Writes go through `set()` which routes
 * each field to the correct table by looking up the role's schema.
 *
 * Identity_key format (reminder):
 *   <cluster>:<role>:<work_ref>     fleet
 *   <cluster>:<role>                 core
 */

export interface IdentityRow {
  identityKey: string;
  cluster: string;
  role: string;
  kind: "fleet" | "core";
  groupingId: string | null;
  stage: string | null;
  statusLine: string | null;
  completed: boolean;
  archived: boolean;
  parkedTaskId: string | null;
  meta: Record<string, unknown>;
  createdAt: string | null;
  updatedAt: string | null;
  /** Per-role attributes (only present for fleet identities). */
  attrs: Record<string, unknown>;
}

/** Parse the JSON `meta` blob defensively. */
function parseMeta(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const p = JSON.parse(s);
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Fetch one identity (with its per-role attrs joined). */
export function getIdentity(db: Database, identityKey: string, configRoot = ccsConfigRoot()): IdentityRow | null {
  const r = db.query("SELECT * FROM identities WHERE identity_key = $k").get({ $k: identityKey }) as
    | Record<string, unknown>
    | null;
  if (!r) return null;
  const role = r.role as string;
  const attrs = readPerRoleAttrs(db, identityKey, role, configRoot);
  return {
    identityKey,
    cluster: r.cluster as string,
    role,
    kind: r.kind as "fleet" | "core",
    groupingId: (r.grouping_id as string) ?? null,
    stage: (r.stage as string) ?? null,
    statusLine: (r.status_line as string) ?? null,
    completed: !!(r.completed as number),
    archived: !!(r.archived as number),
    parkedTaskId: (r.parked_task_id as string) ?? null,
    meta: parseMeta(r.meta as string | null),
    createdAt: (r.created_at as string) ?? null,
    updatedAt: (r.updated_at as string) ?? null,
    attrs,
  };
}

/** Read a fleet identity's per-role attributes; empty for core identities. */
function readPerRoleAttrs(
  db: Database,
  identityKey: string,
  role: string,
  configRoot: string,
): Record<string, unknown> {
  const table = `identity_${tableSlug(role)}`;
  // If the per-role table doesn't exist, this is a core identity — nothing to read.
  const exists = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name=$t")
    .get({ $t: table }) as { name: string } | null;
  if (!exists) return {};
  const row = db.query(`SELECT * FROM ${table} WHERE identity_key = $k`).get({ $k: identityKey }) as
    | Record<string, unknown>
    | null;
  if (!row) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "identity_key" || k === "updated_at") continue;
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

export interface ListFilters {
  cluster?: string;
  role?: string;
  groupingId?: string;
  kind?: "fleet" | "core";
  completed?: boolean;
  archived?: boolean;
}

/** List identities, filterable, joined with per-role attrs. */
export function listIdentities(
  db: Database,
  filters: ListFilters = {},
  configRoot = ccsConfigRoot(),
): IdentityRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.cluster) { clauses.push("cluster = $cluster"); params.$cluster = filters.cluster; }
  if (filters.role)    { clauses.push("role = $role");        params.$role = filters.role; }
  if (filters.groupingId) { clauses.push("grouping_id = $g"); params.$g = filters.groupingId; }
  if (filters.kind)    { clauses.push("kind = $kind");        params.$kind = filters.kind; }
  if (filters.completed !== undefined) { clauses.push("completed = $c"); params.$c = filters.completed ? 1 : 0; }
  if (filters.archived !== undefined)  { clauses.push("archived = $a");  params.$a = filters.archived ? 1 : 0; }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT identity_key FROM identities ${where} ORDER BY identity_key`).all(
    params as never,
  ) as { identity_key: string }[];
  return rows.map((r) => getIdentity(db, r.identity_key, configRoot)!);
}

export interface MintFields {
  cluster: string;
  role: string;
  kind?: "fleet" | "core";     // auto-derived if omitted (fleet if identity_key has :work_ref, else core)
  groupingId?: string | null;
}

/**
 * Mint a new identity row. Idempotent — if the key already exists this is a no-op returning
 * false. The kind is auto-derived from the identity_key's shape if not explicitly given.
 */
/**
 * Reject identity_keys that would poison downstream joins:
 *   - empty / whitespace-only (matches every "no identity" lookup by accident)
 *   - contains any control char (\n, \0, \t, …) — makes debug output unparseable
 *   - has leading/trailing whitespace — silently mismatches an "identical" key
 * The canonical shape is `cluster:role[:work_ref]`. This function only guards
 * against clearly-junk inputs; the cluster/role halves are already validated
 * by their own slug regexes upstream.
 */
function assertIdentityKeyOk(key: string): void {
  if (key !== key.trim() || key.length === 0) {
    throw new Error(`identity_key '${key}' must be a non-empty trimmed string`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(key)) {
    throw new Error(`identity_key '${key}' contains a control character`);
  }
}

export function mintIdentity(db: Database, identityKey: string, fields: MintFields, now: string): boolean {
  assertIdentityKeyOk(identityKey);
  const kind = fields.kind ?? (identityKey.split(":").length > 2 ? "fleet" : "core");
  // Atomic insert-or-noop. The old SELECT-then-INSERT split had a TOCTOU race
  // where two concurrent processes both saw "not there" during their SELECT
  // and both attempted INSERT; the loser hit a PRIMARY KEY conflict and threw.
  // `ON CONFLICT DO NOTHING` collapses the race — the loser's INSERT is a
  // no-op and `changes` is 0. See identities.test.ts "concurrent mint".
  const res = db.query(
    `INSERT INTO identities
       (identity_key, cluster, role, kind, grouping_id, stage, status_line,
        completed, archived, parked_task_id, meta, created_at, updated_at)
     VALUES ($k, $c, $r, $kind, $g, NULL, NULL, 0, 0, NULL, $m, $now, $now)
     ON CONFLICT(identity_key) DO NOTHING`,
  ).run({
    $k: identityKey,
    $c: fields.cluster,
    $r: fields.role,
    $kind: kind,
    $g: fields.groupingId ?? null,
    $m: JSON.stringify({}),
    $now: now,
  });
  return res.changes > 0;
}

/**
 * Apply a bag of field writes to an identity. Fields are routed by lookup:
 *   - universal columns (grouping_id, stage, status_line, completed, archived, parked_task_id,
 *     meta.*) go on `identities`.
 *   - per-role columns (per identity-schema.toml) go on `identity_<role>`.
 *   - unknown fields error with a helpful message.
 *
 * A `meta.<key>` shape writes into the JSON `meta` blob on `identities`; the caller passes
 * `meta.milad_review = "approved"` and we merge. Setting to null removes the key.
 *
 * Returns the number of fields actually changed (excluding no-ops on unchanged values).
 */
export function setIdentityFields(
  db: Database,
  identityKey: string,
  fields: Record<string, unknown>,
  now: string,
  configRoot = ccsConfigRoot(),
): number {
  const current = getIdentity(db, identityKey, configRoot);
  if (!current) throw new Error(`identity '${identityKey}' does not exist — mint it first`);
  const universalPatch: Record<string, unknown> = {};
  const perRolePatch: Record<string, unknown> = {};
  const metaPatch: Record<string, unknown> = {};

  // Load role schema once so we know which columns are per-role.
  const clusterConfigPath = join(configRoot, "clusters", current.cluster);
  let schema = null;
  try {
    schema = loadIdentitySchema(clusterConfigPath, current.role);
  } catch {
    schema = null;
  }
  const perRoleCols = new Set(schema ? Object.keys(schema.columns) : []);
  const universalCols = new Set([
    "grouping_id", "stage", "status_line", "completed", "archived", "parked_task_id",
    // note: cluster/role/kind are NOT settable via this path — a re-key requires a new
    // identity_key. Enforced below.
  ]);

  for (const [key, value] of Object.entries(fields)) {
    if (key === "cluster" || key === "role" || key === "kind" || key === "identity_key") {
      throw new Error(`cannot set '${key}' — identity_key is immutable; mint a new identity to change it`);
    }
    if (key.startsWith("meta.")) {
      metaPatch[key.slice(5)] = value;
      continue;
    }
    if (universalCols.has(key)) {
      universalPatch[key] = value;
      continue;
    }
    if (perRoleCols.has(key)) {
      perRolePatch[key] = value;
      continue;
    }
    throw new Error(
      `unknown field '${key}' for identity '${identityKey}' (role '${current.role}'). ` +
        `Universal: ${[...universalCols].join(", ")}. Per-role: ${[...perRoleCols].join(", ") || "(none — this is a core identity)"}. ` +
        `Use meta.<key> for arbitrary keys.`,
    );
  }

  let changed = 0;

  // Universal columns.
  if (Object.keys(universalPatch).length > 0) {
    const cols = Object.keys(universalPatch);
    const setClauses = cols.map((c) => `${c} = $${c}`).join(", ");
    const params: Record<string, unknown> = { $k: identityKey, $now: now };
    for (const c of cols) {
      params[`$${c}`] = normalizeValue(c, universalPatch[c]);
    }
    db.query(`UPDATE identities SET ${setClauses}, updated_at = $now WHERE identity_key = $k`).run(params as never);
    changed += cols.length;
  }

  // Meta patch: merge into the JSON blob.
  if (Object.keys(metaPatch).length > 0) {
    const merged = { ...current.meta };
    for (const [k, v] of Object.entries(metaPatch)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    db.query(
      "UPDATE identities SET meta = $m, updated_at = $now WHERE identity_key = $k",
    ).run({ $m: JSON.stringify(merged), $now: now, $k: identityKey });
    changed += Object.keys(metaPatch).length;
  }

  // Per-role columns.
  if (Object.keys(perRolePatch).length > 0) {
    if (current.kind !== "fleet" || !schema) {
      throw new Error(
        `identity '${identityKey}' is a core identity — no per-role attributes exist for role '${current.role}'`,
      );
    }
    // Ensure a per-role row exists (UPSERT pattern).
    db.query(
      `INSERT OR IGNORE INTO ${schema.tableName} (identity_key, updated_at) VALUES ($k, $now)`,
    ).run({ $k: identityKey, $now: now });
    const cols = Object.keys(perRolePatch);
    const setClauses = cols.map((c) => `${c} = $${c}`).join(", ");
    const params: Record<string, unknown> = { $k: identityKey, $now: now };
    for (const c of cols) {
      params[`$${c}`] = perRolePatch[c];
    }
    db.query(
      `UPDATE ${schema.tableName} SET ${setClauses}, updated_at = $now WHERE identity_key = $k`,
    ).run(params as never);
    changed += cols.length;
  }

  return changed;
}

/** Coerce booleans and null-shaped inputs to sqlite storage. */
function normalizeValue(col: string, v: unknown): unknown {
  if (v === null) return null;
  if (col === "completed" || col === "archived") return v ? 1 : 0;
  return v;
}

/** Lifecycle: mark completed/archived (also clears the other flag by default). */
export function completeIdentity(db: Database, identityKey: string, now: string): void {
  db.query(
    "UPDATE identities SET completed = 1, archived = 0, updated_at = $now WHERE identity_key = $k",
  ).run({ $now: now, $k: identityKey });
}

export function archiveIdentity(db: Database, identityKey: string, now: string): void {
  db.query(
    "UPDATE identities SET archived = 1, updated_at = $now WHERE identity_key = $k",
  ).run({ $now: now, $k: identityKey });
}

export function uncompleteIdentity(db: Database, identityKey: string, now: string): void {
  db.query(
    "UPDATE identities SET completed = 0, archived = 0, updated_at = $now WHERE identity_key = $k",
  ).run({ $now: now, $k: identityKey });
}

/**
 * The identity's deterministic scratch dir under ~/.ccs. Callers write worker-authored blobs
 * (judgment.json, screenshots/, whatever) here; ccs doesn't inspect its contents.
 *
 *   <root>/clusters/<cluster>/identities/<role>/<slug>/
 * where <slug> is the identity_key's work_ref segment (fleet) or the role (core), with slashes
 * flattened to underscores + '#' preserved so the folder name is filesystem-safe.
 */
export function identityScratchDir(identityKey: string, runtimeRoot = ccsRuntimeRoot()): string {
  const parts = identityKey.split(":");
  const cluster = parts[0] ?? "unknown";
  const role = parts[1] ?? "unknown";
  const rest = parts.slice(2).join(":");
  const slug = rest ? rest.replace(/\//g, "_") : role;
  return join(runtimeRoot, "clusters", cluster, "identities", role, slug);
}

/** Create the identity's scratch dir if absent; return the path. */
export function ensureScratchDir(identityKey: string, runtimeRoot = ccsRuntimeRoot()): string {
  const dir = identityScratchDir(identityKey, runtimeRoot);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Fetch sessions attached to this identity. */
export function sessionsForIdentity(db: Database, identityKey: string): string[] {
  const rows = db.query(
    "SELECT session_id FROM catalogue WHERE identity_key = $k ORDER BY session_id",
  ).all({ $k: identityKey }) as { session_id: string }[];
  return rows.map((r) => r.session_id);
}
