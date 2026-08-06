/**
 * The sidebar's narrow, query-only view of the durable session catalogue.
 *
 * Snapshot reads do not own catalogue schema. They open an existing file read-only, enable
 * SQLite's query-only guard, inspect the shape that is actually present, and select only the facts
 * the projection consumes. Missing optional columns cost their individual feature, never the live
 * queue, and no user_version assumption can turn a compatible additive schema into an outage.
 */
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { RECOMMENDATIONS, type Recommendation } from "../catalogue/enrichment-schema.ts";
import type { StoredEnrichment } from "../catalogue/enrichment.ts";
import type { SidebarLifecycle, SidebarMembership } from "./projection.ts";

export interface CatalogueSnapshotFacts {
  readonly lifecycles: ReadonlyMap<string, SidebarLifecycle>;
  readonly canonicalSessionIds: ReadonlyMap<string, string>;
  readonly preferredTitles: ReadonlyMap<string, string>;
  readonly memberships: ReadonlyMap<string, SidebarMembership>;
  readonly sessionIds: ReadonlyMap<SidebarLifecycle, readonly string[]>;
  readonly auxiliary: ReadonlySet<string>;
  readonly summaries: ReadonlyMap<string, StoredEnrichment>;
}

export type CatalogueReadOutcome =
  | { readonly status: "ok"; readonly facts: CatalogueSnapshotFacts }
  | { readonly status: "missing" }
  | { readonly status: "unreadable"; readonly error: Error }
  | {
    readonly status: "unsupported-schema";
    readonly missing: readonly string[];
  };

interface CatalogueQueryRow {
  readonly session_id: string;
  readonly resume_id: string | null;
  readonly completed: number | null;
  readonly archived: number | null;
  readonly custom_title: string | null;
  readonly enrichment_title: string | null;
  readonly session_class: string | null;
  readonly identity_key: string | null;
  readonly identity_cluster: string | null;
  readonly identity_role: string | null;
  readonly identity_kind: string | null;
  readonly enrichment_state: string | null;
  readonly enrichment_summary: string | null;
  readonly enrichment_history: string | null;
  readonly enrichment_next: string | null;
  readonly enrichment_remaining: string | null;
  readonly enrichment_outstanding: string | null;
  readonly enrichment_recommendation: string | null;
  readonly enrichment_reason: string | null;
  readonly enrichment_junk: number | null;
  readonly enrichment_at_messages: number | null;
  readonly enrichment_at: string | null;
  readonly enrichment_declined: string | null;
}

function tableNames(db: Database): Set<string> {
  const rows = db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all() as Array<{ readonly name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnsOf(db: Database, table: "catalogue" | "identities"): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  return new Set(rows.map((row) => row.name));
}

function selected(
  columns: ReadonlySet<string>,
  name: string,
  fallback = "NULL",
  tableAlias = "c",
): string {
  return columns.has(name) ? `${tableAlias}.${name} AS ${name}` : `${fallback} AS ${name}`;
}

function text(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function recommendation(value: string | null): Recommendation | null {
  const candidate = text(value);
  return candidate !== null && (RECOMMENDATIONS as readonly string[]).includes(candidate)
    ? candidate as Recommendation
    : null;
}

function emptyLifecycleIds(): Map<SidebarLifecycle, string[]> {
  return new Map<SidebarLifecycle, string[]>([
    ["active", []],
    ["completed", []],
    ["archived", []],
  ]);
}

function factsFromRows(rows: readonly CatalogueQueryRow[]): CatalogueSnapshotFacts {
  const lifecycles = new Map<string, SidebarLifecycle>();
  const canonicalSessionIds = new Map<string, string>();
  const preferredTitles = new Map<string, string>();
  const memberships = new Map<string, SidebarMembership>();
  const sessionIds = emptyLifecycleIds();
  const auxiliary = new Set<string>();
  const summaries = new Map<string, StoredEnrichment>();

  // Canonical ids win when a historical resume alias collides with another canonical row.
  for (const row of rows) {
    const lifecycle: SidebarLifecycle = row.archived === 1
      ? "archived"
      : row.completed === 1
      ? "completed"
      : "active";
    lifecycles.set(row.session_id, lifecycle);
    canonicalSessionIds.set(row.session_id, row.session_id);

    const preferred = text(row.custom_title) ?? text(row.enrichment_title);
    if (preferred !== null) {
      preferredTitles.set(row.session_id, preferred);
      if (row.resume_id) preferredTitles.set(row.resume_id, preferred);
    }

    if (
      row.identity_key
      && row.identity_cluster
      && row.identity_role
      && row.identity_kind
    ) {
      const membership: SidebarMembership = {
        identityKey: row.identity_key,
        cluster: row.identity_cluster,
        role: row.identity_role,
        kind: row.identity_kind === "core" ? "core" : "fleet",
      };
      memberships.set(row.session_id, membership);
      if (row.resume_id) memberships.set(row.resume_id, membership);
    }

    const state = text(row.enrichment_state) ?? text(row.enrichment_summary);
    if (state !== null) {
      const summary: StoredEnrichment = {
        state,
        history: text(row.enrichment_history),
        next: text(row.enrichment_next) ?? text(row.enrichment_outstanding),
        remaining: text(row.enrichment_remaining),
        recommendation: recommendation(row.enrichment_recommendation),
        reason: text(row.enrichment_reason),
        junk: row.enrichment_junk === 1,
        atMessages: typeof row.enrichment_at_messages === "number"
          ? row.enrichment_at_messages
          : null,
        at: text(row.enrichment_at),
        declined: recommendation(row.enrichment_declined),
      };
      summaries.set(row.session_id, summary);
      if (row.resume_id) summaries.set(row.resume_id, summary);
    }

    if (row.session_class === "auxiliary") {
      auxiliary.add(row.session_id);
      if (row.resume_id) auxiliary.add(row.resume_id);
    } else {
      sessionIds.get(lifecycle)?.push(row.session_id);
    }
  }

  for (const row of rows) {
    if (!row.resume_id || lifecycles.has(row.resume_id)) continue;
    lifecycles.set(row.resume_id, lifecycles.get(row.session_id) ?? "active");
    canonicalSessionIds.set(row.resume_id, row.session_id);
  }

  return {
    lifecycles,
    canonicalSessionIds,
    preferredTitles,
    memberships,
    sessionIds,
    auxiliary,
    summaries,
  };
}

/** Read only the catalogue facts needed to project one sidebar snapshot. */
export function readCatalogueReadOnly(dbPath: string): CatalogueReadOutcome {
  if (!existsSync(dbPath)) return { status: "missing" };

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA query_only = ON;");

    const tables = tableNames(db);
    if (!tables.has("catalogue")) {
      return { status: "unsupported-schema", missing: ["table:catalogue"] };
    }

    const catalogueColumns = columnsOf(db, "catalogue");
    if (!catalogueColumns.has("session_id")) {
      return { status: "unsupported-schema", missing: ["catalogue.session_id"] };
    }

    const identityColumns = tables.has("identities")
      ? columnsOf(db, "identities")
      : new Set<string>();
    const canJoinIdentity = catalogueColumns.has("identity_key")
      && ["identity_key", "cluster", "role", "kind"].every((name) => identityColumns.has(name));
    const identitySelections = canJoinIdentity
      ? [
        "i.cluster AS identity_cluster",
        "i.role AS identity_role",
        "i.kind AS identity_kind",
      ]
      : [
        "NULL AS identity_cluster",
        "NULL AS identity_role",
        "NULL AS identity_kind",
      ];
    const join = canJoinIdentity
      ? "LEFT JOIN identities i ON i.identity_key = c.identity_key"
      : "";

    const rows = db.query(
      `SELECT c.session_id,
              ${selected(catalogueColumns, "resume_id")},
              ${selected(catalogueColumns, "completed", "0")},
              ${selected(catalogueColumns, "archived", "0")},
              ${selected(catalogueColumns, "custom_title")},
              ${selected(catalogueColumns, "enrichment_title")},
              ${selected(catalogueColumns, "session_class")},
              ${selected(catalogueColumns, "identity_key")},
              ${identitySelections.join(",\n              ")},
              ${selected(catalogueColumns, "enrichment_state")},
              ${selected(catalogueColumns, "enrichment_summary")},
              ${selected(catalogueColumns, "enrichment_history")},
              ${selected(catalogueColumns, "enrichment_next")},
              ${selected(catalogueColumns, "enrichment_remaining")},
              ${selected(catalogueColumns, "enrichment_outstanding")},
              ${selected(catalogueColumns, "enrichment_recommendation")},
              ${selected(catalogueColumns, "enrichment_reason")},
              ${selected(catalogueColumns, "enrichment_junk", "0")},
              ${selected(catalogueColumns, "enrichment_at_messages")},
              ${selected(catalogueColumns, "enrichment_at")},
              ${selected(catalogueColumns, "enrichment_declined")}
         FROM catalogue c
         ${join}`,
    ).all() as CatalogueQueryRow[];

    return { status: "ok", facts: factsFromRows(rows) };
  } catch (error) {
    return {
      status: "unreadable",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    db?.close();
  }
}
