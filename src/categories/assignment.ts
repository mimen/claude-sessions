import type { Database } from "bun:sqlite";
import type { SessionClass } from "../catalogue/db-schema.ts";
import { categoryBySlug, domainTag, type CategoryRegistry } from "./registry.ts";

export type CategorySource = "manual" | "birth" | "location" | "project" | "path" | "parent" | "model" | "backfill";
export type AuxiliaryCategoryPolicy = "reject" | "resolve-root";

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
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
}

export type CategoryMutationResult =
  | { readonly status: "written"; readonly assignment: CategoryAssignment; readonly requestedSessionId: string }
  | { readonly status: "locked"; readonly assignment: CategoryAssignment; readonly requestedSessionId: string }
  | { readonly status: "cleared"; readonly sessionId: string; readonly requestedSessionId: string };

export interface SetCategoryInput {
  readonly sessionId: string;
  readonly slug: string | null;
  readonly source: CategorySource;
  readonly auxiliaryPolicy: AuxiliaryCategoryPolicy;
  readonly confidence?: number | null;
  readonly manualLock?: boolean;
  readonly evidence?: string | null;
  readonly classifierVersion?: string;
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
    attempts: typeof row.category_attempts === "number" ? row.category_attempts : 0,
    nextAttemptAt: (row.next_attempt_at as string) ?? null,
  };
}

export function getCategoryAssignment(db: Database, sessionId: string): CategoryAssignment | null {
  const row = db.query("SELECT * FROM session_category_assignments WHERE session_id = $id").get({ $id: sessionId });
  return row ? rowToAssignment(row as Record<string, unknown>) : null;
}

export interface CategoryAttemptState {
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}

export function getCategoryAttemptState(db: Database, sessionId: string): CategoryAttemptState {
  const row = db.query(
    "SELECT attempts, next_attempt_at, last_error FROM session_category_attempts WHERE session_id = $id",
  ).get({ $id: sessionId }) as {
    readonly attempts: number;
    readonly next_attempt_at: string | null;
    readonly last_error: string | null;
  } | null;
  return row
    ? { attempts: row.attempts, nextAttemptAt: row.next_attempt_at, lastError: row.last_error }
    : { attempts: 0, nextAttemptAt: null, lastError: null };
}

export function getAllCategoryAssignments(db: Database): Map<string, CategoryAssignment> {
  const out = new Map<string, CategoryAssignment>();
  for (const row of db.query("SELECT * FROM session_category_assignments").all() as Record<string, unknown>[]) {
    const assignment = rowToAssignment(row);
    out.set(assignment.sessionId, assignment);
  }
  return out;
}

interface CategoryTarget {
  readonly requestedSessionId: string;
  readonly sessionId: string;
}

/** Resolve a write target without ever creating category state for an arbitrary or auxiliary id. */
export function resolveCategoryWriteTarget(
  db: Database,
  requestedSessionId: string,
  policy: AuxiliaryCategoryPolicy,
  maxDepth = 32,
): CategoryTarget {
  const visited = new Set<string>();
  let current = requestedSessionId;
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (visited.has(current)) throw new Error(`category target ancestry contains a cycle at ${current}`);
    visited.add(current);
    const row = db.query(
      "SELECT session_id, parent_session_id, session_class FROM catalogue WHERE session_id = $id",
    ).get({ $id: current }) as {
      readonly session_id: string;
      readonly parent_session_id: string | null;
      readonly session_class: SessionClass | null;
    } | null;
    if (!row) throw new Error(`category target session does not exist: ${current}`);
    if (row.session_class !== "auxiliary") {
      return { requestedSessionId, sessionId: row.session_id };
    }
    if (policy === "reject") {
      throw new Error(`category assignments belong to retained work roots; ${requestedSessionId} is auxiliary`);
    }
    if (!row.parent_session_id) {
      throw new Error(`auxiliary category target ${current} has no retained parent`);
    }
    current = row.parent_session_id;
  }
  throw new Error(`category target ancestry exceeds ${maxDepth} sessions`);
}

/**
 * The only authorized category write. It validates the retained target, live registry, lock policy,
 * interoperable tag, and provenance in one SQLite transaction.
 */
export function setCategory(
  db: Database,
  registry: CategoryRegistry,
  input: SetCategoryInput,
): CategoryMutationResult {
  let target: CategoryTarget | null = null;
  let failedSessionId = input.sessionId;
  let attemptedWrite = false;
  try {
    if (input.slug !== null && !categoryBySlug(registry, input.slug)) {
      throw new Error(`unknown category "${input.slug}" in registry version ${registry.version}`);
    }
    if (input.confidence !== undefined && input.confidence !== null &&
        (input.confidence < 0 || input.confidence > 1)) {
      throw new Error("category confidence must be between 0 and 1");
    }
    const mutate = db.transaction((): CategoryMutationResult => {
      target = resolveCategoryWriteTarget(db, input.sessionId, input.auxiliaryPolicy);
      failedSessionId = target.sessionId;
      const current = getCategoryAssignment(db, target.sessionId);
      if (current?.manualLock && !input.allowLockedOverride) {
        return { status: "locked", assignment: current, requestedSessionId: target.requestedSessionId };
      }
      attemptedWrite = true;
      db.query("DELETE FROM session_tags WHERE session_id = $id AND entity LIKE 'domain:%'").run({ $id: target.sessionId });
      db.query("DELETE FROM session_category_attempts WHERE session_id = $id").run({ $id: target.sessionId });
      if (input.slug === null) {
        db.query("DELETE FROM session_category_assignments WHERE session_id = $id").run({ $id: target.sessionId });
        return { status: "cleared", sessionId: target.sessionId, requestedSessionId: target.requestedSessionId };
      }
      db.query(
        "INSERT INTO session_tags (session_id, entity) VALUES ($id, $tag) ON CONFLICT DO NOTHING",
      ).run({ $id: target.sessionId, $tag: domainTag(input.slug) });
      db.query(`
        INSERT INTO session_category_assignments
          (session_id, slug, source, confidence, classifier_version, classified_at, manual_lock,
           evidence, failed_write, category_attempts, next_attempt_at)
        VALUES ($id, $slug, $source, $confidence, $version, $at, $lock, $evidence, NULL, 0, NULL)
        ON CONFLICT(session_id) DO UPDATE SET
          slug=excluded.slug, source=excluded.source, confidence=excluded.confidence,
          classifier_version=excluded.classifier_version, classified_at=excluded.classified_at,
          manual_lock=excluded.manual_lock, evidence=excluded.evidence, failed_write=NULL,
          category_attempts=0, next_attempt_at=NULL
      `).run({
        $id: target.sessionId,
        $slug: input.slug,
        $source: input.source,
        $confidence: input.confidence ?? null,
        $version: input.classifierVersion ?? registry.classifierVersion,
        $at: input.classifiedAt,
        $lock: input.manualLock ? 1 : 0,
        $evidence: input.evidence ?? null,
      });
      return {
        status: "written",
        assignment: getCategoryAssignment(db, target.sessionId)!,
        requestedSessionId: target.requestedSessionId,
      };
    });
    return mutate();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (attemptedWrite) {
      try {
        db.query(
          "UPDATE session_category_assignments SET failed_write = $failure WHERE session_id = $id",
        ).run({ $id: failedSessionId, $failure: error.message });
      } catch {
        // Preserve the original boundary failure.
      }
    }
    throw error;
  }
}

export function recordCategoryAttemptFailure(
  db: Database,
  sessionId: string,
  error: Error,
  now: Date,
  maxAttempts = 5,
): void {
  const current = getCategoryAttemptState(db, sessionId);
  const attempts = Math.min(maxAttempts, current.attempts + 1);
  const delayMinutes = Math.min(24 * 60, 2 ** Math.max(0, attempts - 1) * 15);
  const nextAttemptAt = new Date(now.getTime() + delayMinutes * 60_000).toISOString();
  db.query(`
    INSERT INTO session_category_attempts(session_id, attempts, next_attempt_at, last_error)
    VALUES ($id, $attempts, $next, $failure)
    ON CONFLICT(session_id) DO UPDATE SET
      attempts=excluded.attempts, next_attempt_at=excluded.next_attempt_at, last_error=excluded.last_error
  `).run({ $id: sessionId, $failure: error.message, $attempts: attempts, $next: nextAttemptAt });
}

export type EffectiveCategoryFinding =
  | "stored"
  | "inherited"
  | "uncategorized"
  | "parentless-auxiliary"
  | "missing-parent"
  | "cycle"
  | "depth-exceeded";
export interface EffectiveCategory {
  readonly slug: string | null;
  readonly storedSlug: string | null;
  readonly inheritedFrom: string | null;
  readonly finding: EffectiveCategoryFinding;
}

/** Pure bounded ancestry resolution. Inheritance is accepted only after the whole chain is valid. */
export function resolveEffectiveCategory(
  sessionId: string,
  assignments: ReadonlyMap<string, CategoryAssignment>,
  parents: ReadonlyMap<string, string>,
  knownSessions: ReadonlySet<string>,
  classes: ReadonlyMap<string, SessionClass | null> = new Map(),
  maxDepth = 32,
): EffectiveCategory {
  const sessionClass = classes.get(sessionId) ?? null;
  const stored = sessionClass === "auxiliary" ? null : assignments.get(sessionId)?.slug ?? null;
  if (stored) return { slug: stored, storedSlug: stored, inheritedFrom: null, finding: "stored" };

  const visited = new Set<string>([sessionId]);
  let current = sessionId;
  let inherited: { readonly slug: string; readonly from: string } | null = null;
  for (let depth = 0; depth < maxDepth; depth++) {
    const parent = parents.get(current);
    if (!parent) {
      if ((classes.get(current) ?? null) === "auxiliary") {
        return { slug: null, storedSlug: null, inheritedFrom: null, finding: "parentless-auxiliary" };
      }
      return inherited
        ? { slug: inherited.slug, storedSlug: null, inheritedFrom: inherited.from, finding: "inherited" }
        : { slug: null, storedSlug: null, inheritedFrom: null, finding: "uncategorized" };
    }
    if (visited.has(parent)) return { slug: null, storedSlug: null, inheritedFrom: null, finding: "cycle" };
    if (!knownSessions.has(parent)) return { slug: null, storedSlug: null, inheritedFrom: null, finding: "missing-parent" };
    visited.add(parent);
    if (!inherited) {
      const candidate = assignments.get(parent)?.slug;
      if (candidate && (classes.get(parent) ?? null) !== "auxiliary") {
        inherited = { slug: candidate, from: parent };
      }
    }
    current = parent;
  }
  return { slug: null, storedSlug: null, inheritedFrom: null, finding: "depth-exceeded" };
}
