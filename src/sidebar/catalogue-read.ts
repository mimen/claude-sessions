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
import type { Lifecycle } from "../catalogue/db-schema.ts";
import { humanizeSlug, workRefOfIdentityKey } from "../catalogue/identity-key.ts";
import {
  hydrateStoredEnrichment,
  OPTIONAL_ENRICHMENT_COLUMNS,
  type StoredEnrichment,
} from "../catalogue/enrichment.ts";
import type { SidebarLifecycle, SidebarMembership } from "./projection.ts";

export interface CatalogueSnapshotFacts {
  readonly lifecycles: ReadonlyMap<string, SidebarLifecycle>;
  /** Full catalogue lifecycle retained for recommendation decisions; browser shape stays three-state. */
  readonly catalogueLifecycles: ReadonlyMap<string, Lifecycle>;
  readonly canonicalSessionIds: ReadonlyMap<string, string>;
  readonly preferredTitles: ReadonlyMap<string, string>;
  readonly memberships: ReadonlyMap<string, SidebarMembership>;
  readonly sessionIds: ReadonlyMap<SidebarLifecycle, readonly string[]>;
  readonly auxiliary: ReadonlySet<string>;
  /** Sessions positively observed in T3, keyed by canonical id and resume alias. */
  readonly t3Associated: ReadonlySet<string>;
  /** Canonical ids for the dedicated T3 view. */
  readonly t3SessionIds: readonly string[];
  /**
   * Sessions marked incognito, by canonical id and resume alias.
   *
   * They keep their entries in the maps above so a live one can be rendered with its real name,
   * but they are deliberately absent from `sessionIds`, which drives the lifecycle sections and
   * their counts. The caller uses this set twice: to drop every incognito row that is not open
   * right now, and to route the ones that are into their own section.
   */
  readonly incognito: ReadonlySet<string>;
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
  readonly saved: number | null;
  readonly parked_task_id: string | null;
  readonly custom_title: string | null;
  readonly enrichment_title: string | null;
  readonly session_class: string | null;
  readonly incognito: number | null;
  readonly t3_associated: number | null;
  readonly identity_key: string | null;
  readonly identity_cluster: string | null;
  readonly grouping_label?: string | null;
  readonly grouping_short_name?: string | null;
  readonly grouping_meta?: string | null;
  readonly identity_role: string | null;
  readonly identity_kind: string | null;
  readonly identity_completed: number | null;
  readonly identity_archived: number | null;
  readonly identity_saved: number | null;
  readonly identity_parked_task_id: string | null;
  readonly enrichment_state: string | null;
  readonly enrichment_summary: string | null;
  readonly enrichment_history: string | null;
  readonly enrichment_next: string | null;
  readonly enrichment_remaining: string | null;
  readonly enrichment_outstanding: string | null;
  readonly enrichment_recommendation: string | null;
  readonly enrichment_reason: string | null;
  readonly enrichment_junk: number | null;
  readonly enrichment_cwd_correct: number | null;
  readonly enrichment_suggested_location: string | null;
  readonly enrichment_suggested_cwd: string | null;
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

function emptyLifecycleIds(): Map<SidebarLifecycle, string[]> {
  return new Map<SidebarLifecycle, string[]>([
    ["active", []],
    ["completed", []],
    ["saved", []],
  ]);
}

function factsFromRows(rows: readonly CatalogueQueryRow[]): CatalogueSnapshotFacts {
  const lifecycles = new Map<string, SidebarLifecycle>();
  const catalogueLifecycles = new Map<string, Lifecycle>();
  const canonicalSessionIds = new Map<string, string>();
  const preferredTitles = new Map<string, string>();
  const memberships = new Map<string, SidebarMembership>();
  const sessionIds = emptyLifecycleIds();
  const auxiliary = new Set<string>();
  const t3Associated = new Set<string>();
  const t3SessionIds: string[] = [];
  const incognito = new Set<string>();
  const summaries = new Map<string, StoredEnrichment>();
  const canonicalOwners = new Set(rows.map((row) => row.session_id));

  // Canonical ids win when a historical resume alias collides with another canonical row.
  for (const row of rows) {
    // Incognito rows keep their derived facts, because the sidebar shows the ones that are open
    // right now and a row still needs a name. What they never get is a place in `sessionIds`
    // below -- those lists drive the lifecycle sections and their counts, so an entry there would
    // put a marked session under Active and inflate the header beside it. The caller drops the
    // closed ones; see the incognito set's own doc comment.
    const isIncognito = row.incognito === 1;
    if (isIncognito) {
      incognito.add(row.session_id);
      if (row.resume_id) incognito.add(row.resume_id);
    }
    const isT3Associated = row.t3_associated === 1;
    if (isT3Associated) {
      t3Associated.add(row.session_id);
      if (row.resume_id && !canonicalOwners.has(row.resume_id)) t3Associated.add(row.resume_id);
      if (!isIncognito && row.session_class !== "auxiliary") t3SessionIds.push(row.session_id);
    }
    // Match full CatalogueRow hydration exactly: session-scoped non-default flags win, while the
    // joined identity supplies durable lifecycle for rows whose session flags remain at defaults.
    const catalogueLifecycle: Lifecycle = row.saved === 1 || row.identity_saved === 1
      ? "saved"
      : row.completed === 1 || row.identity_completed === 1
        || row.archived === 1 || row.identity_archived === 1
      ? "completed"
      : text(row.parked_task_id) !== null || text(row.identity_parked_task_id) !== null
      ? "parked"
      : "idle";
    const lifecycle: SidebarLifecycle = catalogueLifecycle === "saved"
      ? "saved"
      : catalogueLifecycle === "completed"
      ? "completed"
      : "active";
    lifecycles.set(row.session_id, lifecycle);
    catalogueLifecycles.set(row.session_id, catalogueLifecycle);
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
      const workRef = workRefOfIdentityKey(row.identity_key);
      // The grouping's own short name beats a humanized slug: "Umbrellavation By The Bay" is what
      // the night is called, "Ubtb Bay August" is what its folder is called.
      const groupingName = text(row.grouping_short_name ?? null) ?? text(row.grouping_label ?? null);
      const membership: SidebarMembership = {
        identityKey: row.identity_key,
        cluster: row.identity_cluster,
        role: row.identity_role,
        kind: row.identity_kind === "core" ? "core" : "fleet",
        workRef,
        workLabel: workRef === null ? null : groupingName ?? humanizeSlug(workRef),
        workStartsAt: startsAtOf(row.grouping_meta),
      };
      memberships.set(row.session_id, membership);
      if (row.resume_id) memberships.set(row.resume_id, membership);
    }

    if (text(row.enrichment_state) !== null || text(row.enrichment_summary) !== null) {
      const summary = hydrateStoredEnrichment({ ...row });
      summaries.set(row.session_id, summary);
      if (row.resume_id) summaries.set(row.resume_id, summary);
    }

    if (row.session_class === "auxiliary") {
      auxiliary.add(row.session_id);
      if (row.resume_id) auxiliary.add(row.resume_id);
    } else if (!isIncognito && !(lifecycle === "active" && isT3Associated)) {
      // T3 provenance replaces ordinary Active membership, but Saved and Done remain overlapping
      // lifecycle views by design.
      sessionIds.get(lifecycle)?.push(row.session_id);
    }
  }

  for (const row of rows) {
    if (!row.resume_id || incognito.has(row.session_id) || lifecycles.has(row.resume_id)) continue;
    lifecycles.set(row.resume_id, lifecycles.get(row.session_id) ?? "active");
    catalogueLifecycles.set(
      row.resume_id,
      catalogueLifecycles.get(row.session_id) ?? "idle",
    );
    canonicalSessionIds.set(row.resume_id, row.session_id);
  }

  return {
    lifecycles,
    catalogueLifecycles,
    canonicalSessionIds,
    preferredTitles,
    memberships,
    sessionIds,
    auxiliary,
    t3Associated,
    t3SessionIds,
    incognito,
    summaries,
  };
}

/** Read only the catalogue facts needed to project one sidebar snapshot from an open reader. */
export function readCatalogueDatabase(db: Database): CatalogueReadOutcome {
  try {
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
      && identityColumns.has("identity_key");
    const identitySelection = (name: string, fallback = "NULL"): string =>
      canJoinIdentity && identityColumns.has(name)
        ? `i.${name} AS identity_${name}`
        : `${fallback} AS identity_${name}`;
    const identitySelections = [
      identitySelection("cluster"),
      identitySelection("role"),
      identitySelection("kind"),
      identitySelection("completed", "0"),
      identitySelection("archived", "0"),
      identitySelection("saved", "0"),
      identitySelection("parked_task_id"),
      identitySelection("grouping_id"),
    ];
    // The grouping is what a fleet member's work is ABOUT — the event, the epic — and it owns the
    // display name and whatever dates the cluster recorded. Joined optionally, like the identity
    // itself: an older catalogue without the table still projects, just without the nicety.
    const canJoinGrouping = canJoinIdentity
      && identityColumns.has("grouping_id")
      && tables.has("groupings");
    const groupingSelections = canJoinGrouping
      ? ["g.label AS grouping_label", "g.short_name AS grouping_short_name", "g.meta AS grouping_meta"]
      : ["NULL AS grouping_label", "NULL AS grouping_short_name", "NULL AS grouping_meta"];
    const join = [
      canJoinIdentity ? "LEFT JOIN identities i ON i.identity_key = c.identity_key" : "",
      canJoinGrouping ? "LEFT JOIN groupings g ON g.grouping_id = i.grouping_id" : "",
    ].filter(Boolean).join("\n         ");
    const enrichmentSelections = OPTIONAL_ENRICHMENT_COLUMNS
      .map((name) => selected(catalogueColumns, name, name === "enrichment_junk" ? "0" : "NULL"));

    const rows = db.query(
      `SELECT c.session_id,
              ${selected(catalogueColumns, "resume_id")},
              ${selected(catalogueColumns, "completed", "0")},
              ${selected(catalogueColumns, "archived", "0")},
              ${selected(catalogueColumns, "saved", "0")},
              ${selected(catalogueColumns, "parked_task_id")},
              ${selected(catalogueColumns, "custom_title")},
              ${selected(catalogueColumns, "session_class")},
              ${selected(catalogueColumns, "incognito", "0")},
              ${selected(catalogueColumns, "t3_associated", "0")},
              ${selected(catalogueColumns, "identity_key")},
              ${identitySelections.join(",\n              ")},
              ${groupingSelections.join(",\n              ")},
              ${enrichmentSelections.join(",\n              ")}
         FROM catalogue c
         ${join}`,
    ).all() as CatalogueQueryRow[];

    return { status: "ok", facts: factsFromRows(rows) };
  } catch (error) {
    return {
      status: "unreadable",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * When the grouping's work happens, as epoch milliseconds, or null when nothing recorded it.
 *
 * Milliseconds rather than the stored ISO string because every consumer sorts by it, and a string
 * that fails to parse is a fact the sidebar does not have — not a date at the epoch.
 */
function startsAtOf(meta: string | null | undefined): number | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    const startsAt = parsed.startsAt;
    if (typeof startsAt !== "string") return null;
    const at = Date.parse(startsAt);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/** Read only the catalogue facts needed to project one sidebar snapshot. */
export function readCatalogueReadOnly(dbPath: string): CatalogueReadOutcome {
  if (!existsSync(dbPath)) return { status: "missing" };

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA query_only = ON;");
    return readCatalogueDatabase(db);
  } catch (error) {
    return {
      status: "unreadable",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    db?.close();
  }
}
