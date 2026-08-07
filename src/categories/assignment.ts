import type { Database } from "bun:sqlite";
import { categoryBySlug, domainTag, type CategoryRegistry } from "./registry.ts";

export type CategorySource = "manual" | "birth" | "location" | "project" | "path" | "parent" | "model" | "backfill";

export interface CategoryAssignment {
  readonly sessionId: string;
  readonly slug: string;
  readonly source: CategorySource;
  readonly confidence: number | null;
  readonly classifierVersion: string;
  readonly classifiedAt: string;
  readonly manualLock: boolean;
  readonly evidence: string | null;
  readonly failedWrite: string | null;
}

export type CategoryMutationResult =
  | { readonly status: "written"; readonly assignment: CategoryAssignment }
  | { readonly status: "locked"; readonly assignment: CategoryAssignment }
  | { readonly status: "cleared" };

export interface SetCategoryInput {
  readonly sessionId: string;
  readonly slug: string | null;
  readonly source: CategorySource;
  readonly confidence?: number | null;
  readonly manualLock?: boolean;
  readonly evidence?: string | null;
  readonly classifiedAt: string;
  readonly allowLockedOverride?: boolean;
}

function rowToAssignment(row: Record<string, unknown>): CategoryAssignment {
  return {
    sessionId: row.session_id as string,
    slug: row.slug as string,
    source: row.source as CategorySource,
    confidence: typeof row.confidence === "number" ? row.confidence : null,
    classifierVersion: row.classifier_version as string,
    classifiedAt: row.classified_at as string,
    manualLock: Boolean(row.manual_lock),
    evidence: (row.evidence as string) ?? null,
    failedWrite: (row.failed_write as string) ?? null,
  };
}

export function getCategoryAssignment(db: Database, sessionId: string): CategoryAssignment | null {
  const row = db.query("SELECT * FROM session_category_assignments WHERE session_id = $id").get({ $id: sessionId });
  return row ? rowToAssignment(row as Record<string, unknown>) : null;
}

export function getAllCategoryAssignments(db: Database): Map<string, CategoryAssignment> {
  const out = new Map<string, CategoryAssignment>();
  for (const row of db.query("SELECT * FROM session_category_assignments").all() as Record<string, unknown>[]) {
    const assignment = rowToAssignment(row);
    out.set(assignment.sessionId, assignment);
  }
  return out;
}

/**
 * The only authorized category write. It validates against the live registry, protects manual
 * decisions, replaces every domain:* tag, and writes provenance in one SQLite transaction.
 */
export function setCategory(
  db: Database,
  registry: CategoryRegistry,
  input: SetCategoryInput,
): CategoryMutationResult {
  try {
    if (input.slug !== null && !categoryBySlug(registry, input.slug)) {
      throw new Error(`unknown category "${input.slug}" in registry version ${registry.version}`);
    }
    if (input.confidence !== undefined && input.confidence !== null &&
        (input.confidence < 0 || input.confidence > 1)) {
      throw new Error("category confidence must be between 0 and 1");
    }
    const mutate = db.transaction((): CategoryMutationResult => {
      const current = getCategoryAssignment(db, input.sessionId);
      if (current?.manualLock && !input.allowLockedOverride) return { status: "locked", assignment: current };
      db.query("DELETE FROM session_tags WHERE session_id = $id AND entity LIKE 'domain:%'").run({ $id: input.sessionId });
      if (input.slug === null) {
        db.query("DELETE FROM session_category_assignments WHERE session_id = $id").run({ $id: input.sessionId });
        return { status: "cleared" };
      }
      db.query(
        "INSERT INTO session_tags (session_id, entity) VALUES ($id, $tag) ON CONFLICT DO NOTHING",
      ).run({ $id: input.sessionId, $tag: domainTag(input.slug) });
      db.query(`
        INSERT INTO session_category_assignments
          (session_id, slug, source, confidence, classifier_version, classified_at, manual_lock, evidence, failed_write)
        VALUES ($id, $slug, $source, $confidence, $version, $at, $lock, $evidence, NULL)
        ON CONFLICT(session_id) DO UPDATE SET
          slug=excluded.slug, source=excluded.source, confidence=excluded.confidence,
          classifier_version=excluded.classifier_version, classified_at=excluded.classified_at,
          manual_lock=excluded.manual_lock, evidence=excluded.evidence, failed_write=NULL
      `).run({
        $id: input.sessionId,
        $slug: input.slug,
        $source: input.source,
        $confidence: input.confidence ?? null,
        $version: registry.classifierVersion,
        $at: input.classifiedAt,
        $lock: input.manualLock ? 1 : 0,
        $evidence: input.evidence ?? null,
      });
      return { status: "written", assignment: getCategoryAssignment(db, input.sessionId)! };
    });
    return mutate();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    // Preserve the last coherent assignment and make the failed attempt independently stale. This
    // remains inside the authorized mutation boundary; the next successful write clears the marker.
    try {
      db.query(
        "UPDATE session_category_assignments SET failed_write = $failure WHERE session_id = $id",
      ).run({ $id: input.sessionId, $failure: error.message });
    } catch {
      // The original write error is the actionable failure. A missing legacy table must not mask it.
    }
    throw error;
  }
}

export type EffectiveCategoryFinding = "stored" | "inherited" | "uncategorized" | "missing-parent" | "cycle" | "depth-exceeded";
export interface EffectiveCategory {
  readonly slug: string | null;
  readonly storedSlug: string | null;
  readonly inheritedFrom: string | null;
  readonly finding: EffectiveCategoryFinding;
}

/** Pure bounded ancestry resolution. Never guesses through a broken causal graph. */
export function resolveEffectiveCategory(
  sessionId: string,
  assignments: ReadonlyMap<string, CategoryAssignment>,
  parents: ReadonlyMap<string, string>,
  knownSessions: ReadonlySet<string>,
  maxDepth = 32,
): EffectiveCategory {
  const stored = assignments.get(sessionId)?.slug ?? null;
  if (stored) return { slug: stored, storedSlug: stored, inheritedFrom: null, finding: "stored" };
  const visited = new Set<string>([sessionId]);
  let current = sessionId;
  for (let depth = 0; depth < maxDepth; depth++) {
    const parent = parents.get(current);
    if (!parent) return { slug: null, storedSlug: null, inheritedFrom: null, finding: "uncategorized" };
    if (visited.has(parent)) return { slug: null, storedSlug: null, inheritedFrom: null, finding: "cycle" };
    if (!knownSessions.has(parent)) return { slug: null, storedSlug: null, inheritedFrom: null, finding: "missing-parent" };
    visited.add(parent);
    const inherited = assignments.get(parent)?.slug;
    if (inherited) return { slug: inherited, storedSlug: null, inheritedFrom: parent, finding: "inherited" };
    current = parent;
  }
  return { slug: null, storedSlug: null, inheritedFrom: null, finding: "depth-exceeded" };
}
