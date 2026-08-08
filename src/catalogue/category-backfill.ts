import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { CATALOGUE_PATH, CATEGORY_REGISTRY_PATH } from "../paths.ts";
import { getCategoryAssignment, resolveCategoryWriteTarget, setCategory, type CategoryAssignment } from "../categories/assignment.ts";
import { categoryBySlug, loadCategoryRegistry, slugFromDomainTag } from "../categories/registry.ts";
import { openCatalogue } from "./db-schema.ts";

const DEFAULT_MANIFEST_PATH = resolve(import.meta.dir, "../../docs/category-backfill-manifest-v1.json");
const NormalizeManifestSchema = z.object({
  schema: z.literal(1),
  operation: z.literal("normalize-domain-tags"),
  registryVersion: z.string(),
  auxiliaryPolicy: z.literal("resolve-root"),
  conflictPolicy: z.literal("use-existing-valid-assignment-or-report"),
  invalidPolicy: z.literal("discard-invalid-only-when-one-valid-category-remains"),
}).strict();

const ClassificationSchema = z.object({
  proposedSlug: z.string(),
  confidence: z.number().min(0).max(1),
  evidenceKinds: z.array(z.string()),
  sourceFields: z.array(z.string()),
  reasonCodes: z.array(z.string()),
  requiresReview: z.boolean(),
  flags: z.array(z.string()),
}).strict();

const AssignmentManifestSchema = z.object({
  $schema: z.literal("./session-category-manifest.schema.json"),
  artifactType: z.literal("ccs-session-life-domain-dry-run"),
  version: z.string(),
  capturedAt: z.string(),
  mutationsPerformed: z.literal(false),
  backfillActivated: z.literal(false),
  registry: z.object({
    version: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    slugs: z.array(z.string()),
  }).strict(),
  sourceManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  classifier: z.object({
    version: z.string(),
    purposeFields: z.array(z.string()),
    evidenceKinds: z.array(z.string()),
  }).strict(),
  roots: z.array(z.object({
    sessionId: z.string().min(1),
    classification: ClassificationSchema,
    descendants: z.object({
      retainedSessionIds: z.array(z.string()),
      hiddenAuxiliarySessionIds: z.array(z.string()),
      workflowJournalSessionIds: z.array(z.string()),
    }).strict(),
    metrics: z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
  }).strict()),
}).strict();

const ManifestSchema = z.union([NormalizeManifestSchema, AssignmentManifestSchema]);
type AssignmentManifest = z.infer<typeof AssignmentManifestSchema>;

type JsonAssignment = Omit<CategoryAssignment, "source"> & { readonly source: CategoryAssignment["source"] };
interface JsonCategoryAttempt {
  readonly sessionId: string;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly lastError: string | null;
}
interface SnapshotEntry {
  readonly sessionId: string;
  readonly beforeTags: readonly string[];
  readonly beforeAssignment: JsonAssignment | null;
  readonly beforeAttempt: JsonCategoryAttempt | null;
  readonly afterTags: readonly string[];
  readonly afterAssignment: JsonAssignment | null;
  readonly afterAttempt: JsonCategoryAttempt | null;
}
interface BackfillSnapshot {
  readonly schema: 2;
  readonly operationId: string;
  readonly entries: readonly SnapshotEntry[];
}
interface PlannedRoot {
  readonly rootId: string;
  readonly sourceIds: readonly string[];
  readonly slug: string;
  readonly preserveManualLock: boolean;
}

interface PlannedManifestRoot {
  readonly rootId: string;
  readonly slug: string;
  readonly confidence: number;
  readonly classifierVersion: string;
  readonly classifiedAt: string;
  readonly evidence: string;
  readonly preserveManualLock: boolean;
}

interface ManifestPlan {
  readonly roots: readonly PlannedManifestRoot[];
  readonly alreadyExact: number;
  readonly uncategorized: number;
  readonly issues: readonly string[];
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tagsFor(db: Database, sessionId: string): string[] {
  return (db.query("SELECT entity FROM session_tags WHERE session_id=$id AND entity LIKE 'domain:%' ORDER BY entity").all({ $id: sessionId }) as Array<{ entity: string }>).map((row) => row.entity);
}

function assignmentJson(value: CategoryAssignment | null): JsonAssignment | null {
  return value ? { ...value } : null;
}

function attemptJson(db: Database, sessionId: string): JsonCategoryAttempt | null {
  const row = db.query(
    "SELECT session_id, attempts, next_attempt_at, last_error FROM session_category_attempts WHERE session_id=$id",
  ).get({ $id: sessionId }) as {
    readonly session_id: string;
    readonly attempts: number;
    readonly next_attempt_at: string | null;
    readonly last_error: string | null;
  } | null;
  return row ? {
    sessionId: row.session_id,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  } : null;
}

function plan(db: Database, registryPath: string): { readonly roots: readonly PlannedRoot[]; readonly issues: readonly string[] } {
  const registry = loadCategoryRegistry(registryPath);
  if (!registry.ok) throw registry.error;
  const tagged = db.query("SELECT DISTINCT session_id FROM session_tags WHERE entity LIKE 'domain:%'").all() as Array<{ session_id: string }>;
  const byRoot = new Map<string, Set<string>>();
  const sourceIds = new Map<string, Set<string>>();
  const issues: string[] = [];
  for (const row of tagged) {
    let root: string;
    try {
      root = resolveCategoryWriteTarget(db, row.session_id, "resolve-root").sessionId;
    } catch (cause) {
      issues.push(`${row.session_id}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const slugs = byRoot.get(root) ?? new Set<string>();
    for (const tag of tagsFor(db, row.session_id)) {
      const slug = slugFromDomainTag(tag);
      if (slug && categoryBySlug(registry.value, slug)) slugs.add(slug);
    }
    byRoot.set(root, slugs);
    const sources = sourceIds.get(root) ?? new Set<string>();
    sources.add(row.session_id);
    sources.add(root);
    sourceIds.set(root, sources);
  }
  const roots: PlannedRoot[] = [];
  for (const [rootId, valid] of byRoot) {
    const existing = getCategoryAssignment(db, rootId);
    let slug: string | null = valid.size === 1 ? [...valid][0]! : null;
    if (slug === null && existing && categoryBySlug(registry.value, existing.slug) && valid.has(existing.slug)) slug = existing.slug;
    if (slug === null) {
      issues.push(`${rootId}: ${valid.size === 0 ? "no valid domain tag" : `conflicting domain tags: ${[...valid].sort().join(", ")}`}`);
      continue;
    }
    if (existing?.manualLock && existing.slug !== slug) {
      issues.push(`${rootId}: manual lock ${existing.slug} conflicts with ${slug}`);
      continue;
    }
    const sources = [...sourceIds.get(rootId)!].sort();
    const preserveManualLock = existing?.manualLock === true && existing.slug === slug;
    const alreadyNormalized = existing?.slug === slug
      && (preserveManualLock || (existing.classifierVersion === registry.value.classifierVersion && existing.failedWrite === null))
      && sources.every((id) => JSON.stringify(tagsFor(db, id)) === JSON.stringify(id === rootId ? [`domain:${slug}`] : []))
      && sources.every((id) => id === rootId || attemptJson(db, id) === null);
    if (!alreadyNormalized) roots.push({ rootId, sourceIds: sources, slug, preserveManualLock });
  }
  return { roots: roots.sort((a, b) => a.rootId.localeCompare(b.rootId)), issues: issues.sort() };
}

function planAssignmentManifest(
  db: Database,
  manifest: AssignmentManifest,
  registryPath: string,
  manifestSha256: string,
): ManifestPlan {
  const registry = loadCategoryRegistry(registryPath);
  if (!registry.ok) throw registry.error;
  const roots: PlannedManifestRoot[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  let alreadyExact = 0;
  let uncategorized = 0;
  for (const row of manifest.roots) {
    if (seen.has(row.sessionId)) {
      issues.push(`${row.sessionId}: duplicate manifest root`);
      continue;
    }
    seen.add(row.sessionId);
    const classification = row.classification;
    if (classification.proposedSlug === "uncategorized") {
      uncategorized++;
      continue;
    }
    if (!categoryBySlug(registry.value, classification.proposedSlug)) {
      issues.push(`${row.sessionId}: unknown category ${classification.proposedSlug}`);
      continue;
    }
    try {
      const target = resolveCategoryWriteTarget(db, row.sessionId, "reject");
      if (target.sessionId !== row.sessionId) issues.push(`${row.sessionId}: resolved to unexpected root ${target.sessionId}`);
    } catch (cause) {
      issues.push(`${row.sessionId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const existing = getCategoryAssignment(db, row.sessionId);
    if (existing?.manualLock && existing.slug !== classification.proposedSlug) {
      issues.push(`${row.sessionId}: manual lock ${existing.slug} conflicts with ${classification.proposedSlug}`);
      continue;
    }
    const preserveManualLock = existing?.manualLock === true;
    const evidence = JSON.stringify({
      manifestSha256,
      reasonCodes: classification.reasonCodes,
      flags: classification.flags,
      requiresReview: classification.requiresReview,
    });
    const exactTags = JSON.stringify(tagsFor(db, row.sessionId)) === JSON.stringify([`domain:${classification.proposedSlug}`]);
    const exactAssignment = preserveManualLock
      ? exactTags
      : existing?.slug === classification.proposedSlug
        && existing.source === "backfill"
        && existing.confidence === classification.confidence
        && existing.classifierVersion === manifest.classifier.version
        && existing.classifiedAt === manifest.capturedAt
        && existing.evidence === evidence
        && existing.failedWrite === null
        && exactTags
        && attemptJson(db, row.sessionId) === null;
    if (exactAssignment) {
      alreadyExact++;
      continue;
    }
    roots.push({
      rootId: row.sessionId,
      slug: classification.proposedSlug,
      confidence: classification.confidence,
      classifierVersion: manifest.classifier.version,
      classifiedAt: manifest.capturedAt,
      evidence,
      preserveManualLock,
    });
  }
  return { roots: roots.sort((a, b) => a.rootId.localeCompare(b.rootId)), alreadyExact, uncategorized, issues: issues.sort() };
}

function parseArgs(args: readonly string[]): {
  readonly action: "apply" | "rollback";
  readonly apply: boolean;
  readonly manifestPath: string;
  readonly expected: string | null;
  readonly cataloguePath: string;
  readonly registryPath: string;
  readonly operationId: string | null;
} | null {
  const action = args[0] === "rollback" ? "rollback" : args[0] === "apply" ? "apply" : null;
  if (!action) return null;
  const value = (flag: string): string | null => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] ?? null : null;
  };
  return {
    action,
    apply: args.includes("--apply"),
    manifestPath: value("--manifest") ?? DEFAULT_MANIFEST_PATH,
    expected: value("--expect-sha256"),
    cataloguePath: value("--catalogue") ?? CATALOGUE_PATH(),
    registryPath: value("--registry") ?? CATEGORY_REGISTRY_PATH(),
    operationId: value("--operation"),
  };
}

export function categoryBackfillCommand(args: readonly string[]): number {
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error("usage: ccs category-backfill apply --expect-sha256 <sha256> [--manifest path] [--apply] | rollback --operation <uuid> [--apply]");
    return 2;
  }
  if (parsed.action === "rollback") return rollback(parsed);
  if (!parsed.expected) {
    console.error("ccs category-backfill: --expect-sha256 is required, including for dry-run");
    return 2;
  }
  if (!existsSync(parsed.manifestPath) || !existsSync(parsed.cataloguePath)) {
    console.error("ccs category-backfill: manifest or catalogue does not exist");
    return 1;
  }
  const bytes = readFileSync(parsed.manifestPath);
  const actual = digest(bytes);
  if (actual !== parsed.expected) {
    console.error(`ccs category-backfill: manifest sha256 mismatch: expected ${parsed.expected}, got ${actual}`);
    return 1;
  }
  let manifestJson: object;
  try {
    manifestJson = JSON.parse(bytes.toString("utf8")) as object;
  } catch (cause) {
    console.error(`ccs category-backfill: manifest is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  const manifest = ManifestSchema.safeParse(manifestJson);
  const registry = loadCategoryRegistry(parsed.registryPath);
  if (!manifest.success) {
    console.error(`ccs category-backfill: ${z.prettifyError(manifest.error)}`);
    return 1;
  }
  if (!registry.ok) {
    console.error(`ccs category-backfill: ${registry.error.message}`);
    return 1;
  }
  if ("operation" in manifest.data) {
    if (manifest.data.registryVersion !== registry.value.version) {
      console.error(`ccs category-backfill: manifest targets registry ${manifest.data.registryVersion}, installed registry is ${registry.value.version}`);
      return 1;
    }
  } else {
    const installedSlugs = registry.value.categories.map((category) => category.slug);
    const installedRegistrySha256 = digest(readFileSync(parsed.registryPath));
    if (manifest.data.registry.version !== registry.value.version
      || manifest.data.registry.sha256 !== installedRegistrySha256
      || JSON.stringify(manifest.data.registry.slugs) !== JSON.stringify(installedSlugs)) {
      console.error("ccs category-backfill: assignment manifest registry metadata does not match the installed registry");
      return 1;
    }
    return applyAssignmentManifest({
      manifest: manifest.data,
      manifestSha256: actual,
      manifestPath: parsed.manifestPath,
      cataloguePath: parsed.cataloguePath,
      registryPath: parsed.registryPath,
      apply: parsed.apply,
    });
  }
  const readonly = new Database(parsed.cataloguePath, { readonly: true });
  let planned;
  try {
    planned = plan(readonly, parsed.registryPath);
  } catch (cause) {
    readonly.close();
    console.error(`ccs category-backfill: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  readonly.close();
  console.log(`category backfill (${parsed.apply ? "APPLY" : "DRY-RUN"}): ${planned.roots.length} roots ready, ${planned.issues.length} unresolved`);
  for (const issue of planned.issues) console.error(`  unresolved: ${issue}`);
  if (!parsed.apply) return 0;
  if (planned.issues.length > 0) {
    console.error("ccs category-backfill: unresolved rows make apply fail closed");
    return 1;
  }
  if (planned.roots.length === 0) return 0;
  const db = openCatalogue(parsed.cataloguePath, { materialize: false });
  const operationId = randomUUID();
  const appliedAt = new Date().toISOString();
  try {
    db.transaction(() => {
      const live = plan(db, parsed.registryPath);
      if (JSON.stringify(live) !== JSON.stringify(planned)) throw new Error("catalogue changed after dry-run");
      const before = new Map<string, { tags: string[]; assignment: JsonAssignment | null; attempt: JsonCategoryAttempt | null }>();
      for (const root of live.roots) for (const id of root.sourceIds) {
        before.set(id, {
          tags: tagsFor(db, id),
          assignment: assignmentJson(getCategoryAssignment(db, id)),
          attempt: attemptJson(db, id),
        });
      }
      for (const root of live.roots) {
        if (root.preserveManualLock) {
          db.query("DELETE FROM session_tags WHERE session_id=$id AND entity LIKE 'domain:%'").run({ $id: root.rootId });
          db.query("INSERT INTO session_tags(session_id,entity) VALUES ($id,$tag)").run({
            $id: root.rootId,
            $tag: `domain:${root.slug}`,
          });
        } else {
          setCategory(db, registry.value, {
            sessionId: root.rootId,
            auxiliaryPolicy: "reject",
            slug: root.slug,
            source: "backfill",
            confidence: 1,
            evidence: `category-backfill manifest ${actual}`,
            classifiedAt: appliedAt,
            allowLockedOverride: false,
          });
          const priorAttempt = before.get(root.rootId)?.attempt ?? null;
          if (priorAttempt) {
            db.query("INSERT INTO session_category_attempts(session_id,attempts,next_attempt_at,last_error) VALUES ($id,$attempts,$next,$error)").run({
              $id: priorAttempt.sessionId,
              $attempts: priorAttempt.attempts,
              $next: priorAttempt.nextAttemptAt,
              $error: priorAttempt.lastError,
            });
          }
        }
        for (const id of root.sourceIds) if (id !== root.rootId) {
          db.query("DELETE FROM session_tags WHERE session_id=$id AND entity LIKE 'domain:%'").run({ $id: id });
          db.query("DELETE FROM session_category_assignments WHERE session_id=$id").run({ $id: id });
          db.query("DELETE FROM session_category_attempts WHERE session_id=$id").run({ $id: id });
        }
      }
      const snapshot: BackfillSnapshot = {
        schema: 2,
        operationId,
        entries: [...before].map(([sessionId, state]) => ({
          sessionId,
          beforeTags: state.tags,
          beforeAssignment: state.assignment,
          beforeAttempt: state.attempt,
          afterTags: tagsFor(db, sessionId),
          afterAssignment: assignmentJson(getCategoryAssignment(db, sessionId)),
          afterAttempt: attemptJson(db, sessionId),
        })),
      };
      db.query("INSERT INTO category_backfill_audits(operation_id, manifest_sha256, manifest_path, applied_at, snapshot_json) VALUES ($id,$sha,$path,$at,$snapshot)").run({
        $id: operationId, $sha: actual, $path: parsed.manifestPath, $at: appliedAt, $snapshot: JSON.stringify(snapshot),
      });
    })();
  } catch (cause) {
    db.close();
    console.error(`ccs category-backfill: apply rolled back: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  db.close();
  const locked = planned.roots.filter((root) => root.preserveManualLock).length;
  console.log(`applied ${planned.roots.length - locked} category roots; preserved ${locked} matching manual locks; audit operation ${operationId}`);
  return 0;
}

function applyAssignmentManifest(args: {
  readonly manifest: AssignmentManifest;
  readonly manifestSha256: string;
  readonly manifestPath: string;
  readonly cataloguePath: string;
  readonly registryPath: string;
  readonly apply: boolean;
}): number {
  const readonly = new Database(args.cataloguePath, { readonly: true });
  let planned: ManifestPlan;
  try {
    planned = planAssignmentManifest(readonly, args.manifest, args.registryPath, args.manifestSha256);
  } catch (cause) {
    readonly.close();
    console.error(`ccs category-backfill: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  readonly.close();
  console.log(
    `category assignment backfill (${args.apply ? "APPLY" : "DRY-RUN"}): ${planned.roots.length} roots ready, `
      + `${planned.alreadyExact} already exact, ${planned.uncategorized} uncategorized skipped, ${planned.issues.length} unresolved`,
  );
  for (const issue of planned.issues) console.error(`  unresolved: ${issue}`);
  if (!args.apply) return 0;
  if (planned.issues.length > 0) {
    console.error("ccs category-backfill: unresolved rows make apply fail closed");
    return 1;
  }
  if (planned.roots.length === 0) return 0;
  const registry = loadCategoryRegistry(args.registryPath);
  if (!registry.ok) {
    console.error(`ccs category-backfill: ${registry.error.message}`);
    return 1;
  }
  const db = openCatalogue(args.cataloguePath, { materialize: false });
  const operationId = randomUUID();
  const appliedAt = new Date().toISOString();
  try {
    db.transaction(() => {
      const live = planAssignmentManifest(db, args.manifest, args.registryPath, args.manifestSha256);
      if (JSON.stringify(live) !== JSON.stringify(planned)) throw new Error("catalogue changed after dry-run");
      const before = new Map<string, { tags: string[]; assignment: JsonAssignment | null; attempt: JsonCategoryAttempt | null }>();
      for (const root of live.roots) {
        before.set(root.rootId, {
          tags: tagsFor(db, root.rootId),
          assignment: assignmentJson(getCategoryAssignment(db, root.rootId)),
          attempt: attemptJson(db, root.rootId),
        });
        if (root.preserveManualLock) {
          db.query("DELETE FROM session_tags WHERE session_id=$id AND entity LIKE 'domain:%'").run({ $id: root.rootId });
          db.query("INSERT INTO session_tags(session_id,entity) VALUES ($id,$tag)").run({
            $id: root.rootId,
            $tag: `domain:${root.slug}`,
          });
        } else {
          setCategory(db, registry.value, {
            sessionId: root.rootId,
            auxiliaryPolicy: "reject",
            slug: root.slug,
            source: "backfill",
            confidence: root.confidence,
            classifierVersion: root.classifierVersion,
            evidence: root.evidence,
            classifiedAt: root.classifiedAt,
            allowLockedOverride: false,
          });
        }
      }
      const snapshot: BackfillSnapshot = {
        schema: 2,
        operationId,
        entries: [...before].map(([sessionId, state]) => ({
          sessionId,
          beforeTags: state.tags,
          beforeAssignment: state.assignment,
          beforeAttempt: state.attempt,
          afterTags: tagsFor(db, sessionId),
          afterAssignment: assignmentJson(getCategoryAssignment(db, sessionId)),
          afterAttempt: attemptJson(db, sessionId),
        })),
      };
      db.query("INSERT INTO category_backfill_audits(operation_id, manifest_sha256, manifest_path, applied_at, snapshot_json) VALUES ($id,$sha,$path,$at,$snapshot)").run({
        $id: operationId,
        $sha: args.manifestSha256,
        $path: args.manifestPath,
        $at: appliedAt,
        $snapshot: JSON.stringify(snapshot),
      });
    })();
  } catch (cause) {
    db.close();
    console.error(`ccs category-backfill: apply rolled back: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  db.close();
  const locked = planned.roots.filter((root) => root.preserveManualLock).length;
  console.log(
    `applied ${planned.roots.length - locked} session category assignments; preserved ${locked} matching manual locks; `
      + `skipped ${planned.uncategorized} uncategorized roots; audit operation ${operationId}`,
  );
  return 0;
}

function rollback(args: NonNullable<ReturnType<typeof parseArgs>>): number {
  if (!args.operationId || !existsSync(args.cataloguePath)) {
    console.error("ccs category-backfill: rollback requires an existing catalogue and --operation <uuid>");
    return 2;
  }
  const db = openCatalogue(args.cataloguePath, { materialize: false });
  const audit = db.query("SELECT snapshot_json, reverted_at FROM category_backfill_audits WHERE operation_id=$id").get({ $id: args.operationId }) as { snapshot_json: string; reverted_at: string | null } | null;
  if (!audit || audit.reverted_at) {
    db.close();
    console.error(`ccs category-backfill: audit ${args.operationId} is missing or already reverted`);
    return 1;
  }
  let snapshot: BackfillSnapshot;
  try {
    snapshot = JSON.parse(audit.snapshot_json) as BackfillSnapshot;
  } catch (cause) {
    db.close();
    console.error(`ccs category-backfill: audit ${args.operationId} has invalid snapshot JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  if (snapshot.schema !== 2 || !Array.isArray(snapshot.entries)) {
    db.close();
    console.error(`ccs category-backfill: audit ${args.operationId} uses unsupported snapshot schema`);
    return 1;
  }
  const conflicts = snapshot.entries.filter((entry) =>
    JSON.stringify(tagsFor(db, entry.sessionId)) !== JSON.stringify(entry.afterTags)
    || JSON.stringify(assignmentJson(getCategoryAssignment(db, entry.sessionId))) !== JSON.stringify(entry.afterAssignment)
    || JSON.stringify(attemptJson(db, entry.sessionId)) !== JSON.stringify(entry.afterAttempt));
  console.log(`category backfill rollback (${args.apply ? "APPLY" : "DRY-RUN"}): ${snapshot.entries.length} sessions, ${conflicts.length} conflicts`);
  if (conflicts.length > 0 || !args.apply) {
    db.close();
    return conflicts.length > 0 ? 1 : 0;
  }
  try {
    db.transaction(() => {
      for (const entry of snapshot.entries) {
        db.query("DELETE FROM session_tags WHERE session_id=$id AND entity LIKE 'domain:%'").run({ $id: entry.sessionId });
        for (const tag of entry.beforeTags) db.query("INSERT INTO session_tags(session_id,entity) VALUES ($id,$tag) ON CONFLICT DO NOTHING").run({ $id: entry.sessionId, $tag: tag });
        db.query("DELETE FROM session_category_assignments WHERE session_id=$id").run({ $id: entry.sessionId });
        if (entry.beforeAssignment) {
          const a = entry.beforeAssignment;
          db.query("INSERT INTO session_category_assignments(session_id,slug,source,confidence,classifier_version,classified_at,manual_lock,evidence,failed_write,category_attempts,next_attempt_at) VALUES ($id,$slug,$source,$confidence,$version,$at,$lock,$evidence,$failed,$attempts,$next)").run({
            $id: a.sessionId, $slug: a.slug, $source: a.source, $confidence: a.confidence, $version: a.classifierVersion,
            $at: a.classifiedAt, $lock: a.manualLock ? 1 : 0, $evidence: a.evidence, $failed: a.failedWrite,
            $attempts: a.attempts, $next: a.nextAttemptAt,
          });
        }
        db.query("DELETE FROM session_category_attempts WHERE session_id=$id").run({ $id: entry.sessionId });
        if (entry.beforeAttempt) {
          const attempt = entry.beforeAttempt;
          db.query("INSERT INTO session_category_attempts(session_id,attempts,next_attempt_at,last_error) VALUES ($id,$attempts,$next,$error)").run({
            $id: attempt.sessionId,
            $attempts: attempt.attempts,
            $next: attempt.nextAttemptAt,
            $error: attempt.lastError,
          });
        }
      }
      db.query("UPDATE category_backfill_audits SET reverted_at=$at WHERE operation_id=$id").run({ $id: args.operationId, $at: new Date().toISOString() });
    })();
  } catch (cause) {
    db.close();
    console.error(`ccs category-backfill: rollback failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    return 1;
  }
  db.close();
  console.log(`rolled back category audit ${args.operationId}`);
  return 0;
}
