import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import type { SessionClass } from "../catalogue/db-schema.ts";
import {
  resolveEffectiveCategory,
  type CategoryAssignment,
  type EffectiveCategoryFinding,
} from "../categories/assignment.ts";
import { categoryBySlug, loadCategoryRegistry } from "../categories/registry.ts";

export const SIDEBAR_CATEGORY_PROJECTION_VERSION = 1;

export interface SidebarCategoryProjection {
  readonly schema: typeof SIDEBAR_CATEGORY_PROJECTION_VERSION;
  readonly effectiveSlug: string | null;
  readonly storedSlug: string | null;
  readonly compactLabel: string | null;
  readonly fullLabel: string | null;
  readonly hex: string | null;
  readonly source: CategoryAssignment["source"] | null;
  readonly manualLock: boolean;
  readonly finding: EffectiveCategoryFinding | "category-invalid";
  readonly registryVersion: string;
}

export type SidebarCategoryProjectionOutcome =
  | { readonly status: "ok"; readonly categories: ReadonlyMap<string, SidebarCategoryProjection> }
  | { readonly status: "unavailable"; readonly error: string };

function tableExists(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=$name").get({ $name: name }) !== null;
}

/** Versioned read projection for cmux/sidebar clients. Swift consumes this wire shape, never SQLite. */
export function readSidebarCategoryProjection(
  cataloguePath: string,
  registryPath: string,
): SidebarCategoryProjectionOutcome {
  const registry = loadCategoryRegistry(registryPath);
  if (!registry.ok) return { status: "unavailable", error: registry.error.message };
  if (!existsSync(cataloguePath)) return { status: "unavailable", error: `catalogue unavailable at ${cataloguePath}` };

  const db = new Database(cataloguePath, { readonly: true });
  try {
    db.exec("PRAGMA query_only = ON;");
    if (!tableExists(db, "catalogue") || !tableExists(db, "session_category_assignments")) {
      return { status: "unavailable", error: "catalogue category schema is unavailable" };
    }
    const rows = db.query(
      "SELECT session_id, resume_id, parent_session_id, session_class FROM catalogue",
    ).all() as Array<{
      readonly session_id: string;
      readonly resume_id: string | null;
      readonly parent_session_id: string | null;
      readonly session_class: SessionClass | null;
    }>;
    const assignmentRows = db.query("SELECT * FROM session_category_assignments").all() as Array<Record<string, string | number | null>>;
    const assignments = new Map<string, CategoryAssignment>();
    for (const row of assignmentRows) {
      assignments.set(String(row.session_id), {
        sessionId: String(row.session_id),
        slug: String(row.slug),
        source: row.source as CategoryAssignment["source"],
        confidence: typeof row.confidence === "number" ? row.confidence : null,
        classifierVersion: String(row.classifier_version),
        classifiedAt: String(row.classified_at),
        manualLock: Boolean(row.manual_lock),
        evidence: typeof row.evidence === "string" ? row.evidence : null,
        failedWrite: typeof row.failed_write === "string" ? row.failed_write : null,
        attempts: typeof row.category_attempts === "number" ? row.category_attempts : 0,
        nextAttemptAt: typeof row.next_attempt_at === "string" ? row.next_attempt_at : null,
      });
    }
    const known = new Set(rows.map((row) => row.session_id));
    const parents = new Map(rows.flatMap((row) => row.parent_session_id ? [[row.session_id, row.parent_session_id] as const] : []));
    const classes = new Map(rows.map((row) => [row.session_id, row.session_class] as const));
    const projected = new Map<string, SidebarCategoryProjection>();
    for (const row of rows) {
      const effective = resolveEffectiveCategory(row.session_id, assignments, parents, known, classes);
      const definition = effective.slug ? categoryBySlug(registry.value, effective.slug) : null;
      const acceptedAssignmentId = effective.finding === "stored"
        ? row.session_id
        : effective.finding === "inherited"
        ? effective.inheritedFrom
        : null;
      const storedAssignment = acceptedAssignmentId ? assignments.get(acceptedAssignmentId) ?? null : null;
      const value: SidebarCategoryProjection = {
        schema: SIDEBAR_CATEGORY_PROJECTION_VERSION,
        effectiveSlug: effective.slug,
        storedSlug: effective.storedSlug,
        compactLabel: definition?.compactName ?? null,
        fullLabel: definition?.name ?? null,
        hex: definition?.color ?? null,
        source: storedAssignment?.source ?? null,
        manualLock: storedAssignment?.manualLock ?? false,
        finding: effective.slug !== null && definition === null ? "category-invalid" : effective.finding,
        registryVersion: registry.value.version,
      };
      projected.set(row.session_id, value);
      if (row.resume_id) projected.set(row.resume_id, value);
    }
    return { status: "ok", categories: projected };
  } catch (cause) {
    return { status: "unavailable", error: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    db.close();
  }
}
