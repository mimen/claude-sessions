import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
  addTag,
  createHistoricalDetachedChildBackfillAudit,
  deleteHistoricalDetachedChildBackfillPlaceholder,
  ensureRow,
  getHistoricalDetachedChildBackfillAudit,
  markHistoricalDetachedChildBackfillReverted,
  openCatalogue,
  removeTag,
  setMeta,
  setParent,
  setSessionClass,
  type SessionClass,
} from "./db.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import {
  exactHistoricalDetachedChildBackfillProposals,
  HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY,
  validateHistoricalDetachedChildBackfillManifest,
  type HistoricalDetachedChildBackfillProposal,
} from "../cleanup/historical-detached-child-backfill.ts";
import type { HistoricalDetachedChildManifest } from "../cleanup/historical-detached-child-classifier.ts";

const DEFAULT_MANIFEST_PATH = resolve(import.meta.dir, "../../docs/reports/detached-children-2026-07-12-onward.json");
const MAX_SQL_BINDINGS = 350;

type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type MatchDimension = HistoricalDetachedChildBackfillProposal["evidence"]["matchedDimensions"][number];

interface BackfillArgs {
  readonly action: "apply" | "rollback";
  readonly manifestPath: string;
  readonly expectedSha256: string | null;
  readonly indexPath: string;
  readonly cataloguePath: string;
  readonly operationId: string | null;
  readonly apply: boolean;
}

interface IndexedSession {
  readonly sessionId: string;
  readonly resumeId: string;
}

interface BackfillPreimage {
  readonly exists: boolean;
  readonly sessionClass: SessionClass | null;
  readonly parentSessionId: string | null;
  readonly tags: readonly string[];
  readonly provenancePresent: boolean;
  readonly provenance: JsonValue | null;
}

interface CurrentSessionState extends BackfillPreimage {
  /** Complete session meta is needed to refuse deleting a row changed after this operation. */
  readonly meta: { readonly [key: string]: JsonValue };
  /** True when no non-backfill catalogue field has been populated since row creation. */
  readonly unmanagedFieldsClear: boolean;
}

interface BackfillProvenance {
  readonly version: 1;
  readonly manifestSha256: string;
  readonly findingIndex: number;
  readonly causalParentSessionId: string;
  readonly evidence: HistoricalDetachedChildBackfillProposal["evidence"];
}

interface BackfillAction {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly before: CurrentSessionState;
  readonly tagsToAdd: readonly string[];
  readonly provenance: BackfillProvenance;
}

interface BackfillSnapshotEntry {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly before: BackfillPreimage;
  readonly tagsAdded: readonly string[];
  readonly provenance: BackfillProvenance;
}

interface BackfillSnapshot {
  readonly version: 1;
  readonly operationId: string;
  readonly manifestSha256: string;
  readonly manifestPath: string;
  readonly appliedAt: string;
  readonly entries: readonly BackfillSnapshotEntry[];
}

/**
 * Apply only reviewed, exact detached-child proposals. Dry-run is the default; applying requires
 * the operator to pin the exact bytes reviewed with --expect-sha256.
 */
export function historicalDetachedChildBackfillCommand(args: readonly string[]): number {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    console.error(`ccs historical-backfill: ${parsed.error.message}`);
    return 2;
  }
  return parsed.value.action === "rollback" ? rollback(parsed.value) : applyManifest(parsed.value);
}

function applyManifest(args: BackfillArgs): number {
  if (args.expectedSha256 === null) {
    console.error("ccs historical-backfill: --expect-sha256 is required, including for dry-run");
    return 2;
  }
  const manifest = loadManifest(args.manifestPath, args.expectedSha256);
  if (!manifest.ok) {
    console.error(`ccs historical-backfill: ${manifest.error.message}`);
    return 2;
  }
  const proposals = exactHistoricalDetachedChildBackfillProposals(manifest.value.manifest);
  if (!proposals.ok) {
    console.error(`ccs historical-backfill: ${proposals.error.message}`);
    return 2;
  }
  const resolved = resolveTargets(proposals.value, args.indexPath);
  if (!resolved.ok) {
    console.error(`ccs historical-backfill: ${resolved.error.message}`);
    return 1;
  }
  const states = readCurrentStates(args.cataloguePath, resolved.value.targets.map((target) => target.childSessionId));
  if (!states.ok) {
    console.error(`ccs historical-backfill: ${states.error.message}`);
    return 1;
  }
  const actions = buildActions(resolved.value.targets, states.value, resolved.value.aliases, manifest.value.sha256);
  if (!actions.ok) {
    console.error(`ccs historical-backfill: ${actions.error.message}`);
    return 1;
  }

  const pending = actions.value.filter((action) => requiresWrite(action));
  printApplySummary(args, manifest.value.sha256, proposals.value.length, pending.length, actions.value.length - pending.length);
  if (!args.apply) return 0;
  if (pending.length === 0) return 0;

  ensureDataDir();
  const db = openCatalogue(args.cataloguePath, { materialize: false });
  const operationId = randomUUID();
  const appliedAt = new Date().toISOString();
  const snapshot: BackfillSnapshot = {
    version: 1,
    operationId,
    manifestSha256: manifest.value.sha256,
    manifestPath: args.manifestPath,
    appliedAt,
    entries: pending.map((action) => ({
      childSessionId: action.childSessionId,
      parentSessionId: action.parentSessionId,
      before: backfillPreimageOf(action.before),
      tagsAdded: action.tagsToAdd,
      provenance: action.provenance,
    })),
  };
  try {
    db.transaction(() => {
      // The read-only plan above is only advisory. Re-read every touched state inside the write
      // transaction so another catalogue writer cannot turn a reviewed exact plan into an overwrite.
      const liveStates = readCurrentStatesFromDatabase(db, pending.map((action) => action.childSessionId));
      const revalidated = buildActions(
        resolved.value.targets.filter((target) => pending.some((action) => action.childSessionId === target.childSessionId)),
        liveStates,
        resolved.value.aliases,
        manifest.value.sha256,
      );
      if (!revalidated.ok || !sameActions(pending, revalidated.ok ? revalidated.value : [])) {
        throw new Error(revalidated.ok
          ? "catalogue state changed after dry-run; no historical backfill was written"
          : revalidated.error.message);
      }
      createHistoricalDetachedChildBackfillAudit(db, {
        operationId,
        manifestSha256: manifest.value.sha256,
        manifestPath: args.manifestPath,
        appliedAt,
        snapshotJson: JSON.stringify(snapshot),
      });
      for (const action of pending) applyAction(db, action, appliedAt);
    })();
  } catch (error) {
    db.close();
    console.error(`ccs historical-backfill: apply rolled back: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  db.close();
  console.log(`applied ${pending.length} exact historical auxiliary assignments; audit operation ${operationId}`);
  return 0;
}

function rollback(args: BackfillArgs): number {
  if (args.operationId === null) {
    console.error("ccs historical-backfill: rollback requires --operation <uuid>");
    return 2;
  }
  if (!existsSync(args.cataloguePath)) {
    console.error(`ccs historical-backfill: catalogue not found: ${args.cataloguePath}`);
    return 1;
  }

  const db = new Database(args.cataloguePath, { readonly: true });
  let audit;
  try {
    audit = getHistoricalDetachedChildBackfillAudit(db, args.operationId);
  } catch (error) {
    db.close();
    console.error(`ccs historical-backfill: cannot read audit: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  db.close();
  if (audit === null) {
    console.error(`ccs historical-backfill: no audit operation ${args.operationId}`);
    return 1;
  }
  if (audit.revertedAt !== null) {
    console.error(`ccs historical-backfill: operation ${args.operationId} was already reverted at ${audit.revertedAt}`);
    return 1;
  }
  const snapshot = parseSnapshot(audit.snapshotJson, args.operationId);
  if (!snapshot.ok) {
    console.error(`ccs historical-backfill: ${snapshot.error.message}`);
    return 1;
  }

  const aliases = aliasesForIds(args.indexPath, snapshot.value.entries.flatMap((entry) => [entry.childSessionId, entry.parentSessionId]));
  if (!aliases.ok) {
    console.error(`ccs historical-backfill: ${aliases.error.message}`);
    return 1;
  }
  const states = readCurrentStates(args.cataloguePath, snapshot.value.entries.map((entry) => entry.childSessionId));
  if (!states.ok) {
    console.error(`ccs historical-backfill: ${states.error.message}`);
    return 1;
  }
  const conflicts = rollbackConflicts(snapshot.value, states.value, aliases.value);
  console.log(`historical detached-child rollback (${args.apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`  operation: ${args.operationId}`);
  console.log(`  managed assignments: ${snapshot.value.entries.length}`);
  console.log(`  conflicts: ${conflicts.length}`);
  if (conflicts.length > 0) {
    for (const conflict of conflicts) console.error(`  conflict: ${conflict}`);
    return 1;
  }
  if (!args.apply) {
    console.log("  dry run only — pass --apply to restore the recorded managed fields");
    return 0;
  }

  const writable = openCatalogue(args.cataloguePath, { materialize: false });
  const revertedAt = new Date().toISOString();
  try {
    writable.transaction(() => {
      const live = readCurrentStatesFromDatabase(writable, snapshot.value.entries.map((entry) => entry.childSessionId));
      const liveConflicts = rollbackConflicts(snapshot.value, live, aliases.value);
      if (liveConflicts.length > 0) throw new Error(liveConflicts.join("; "));
      for (const entry of snapshot.value.entries) restoreAction(writable, entry, revertedAt);
      markHistoricalDetachedChildBackfillReverted(writable, args.operationId!, revertedAt);
    })();
  } catch (error) {
    writable.close();
    console.error(`ccs historical-backfill: rollback rolled back: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  writable.close();
  console.log(`restored ${snapshot.value.entries.length} historical managed-field preimages; audit operation ${args.operationId} marked reverted`);
  return 0;
}

function parseArgs(args: readonly string[]): { readonly ok: true; readonly value: BackfillArgs } | { readonly ok: false; readonly error: Error } {
  const action = args[0];
  if (action !== "detached-children" && action !== "rollback") {
    return { ok: false, error: new Error("usage: ccs historical-backfill <detached-children|rollback> [options]") };
  }
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    const match = /^(--(?:manifest|expect-sha256|index|catalogue|operation))(?:=(.*))?$/.exec(arg);
    if (match === null) return { ok: false, error: new Error(`unknown argument: ${arg}`) };
    const key = match[1]!;
    const value = match[2] === undefined ? args[++index] : match[2];
    if (!value) return { ok: false, error: new Error(`${key} requires a value`) };
    if (values.has(key)) return { ok: false, error: new Error(`${key} was supplied more than once`) };
    values.set(key, value);
  }
  const expectedSha256 = values.get("--expect-sha256") ?? null;
  if (expectedSha256 !== null && !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    return { ok: false, error: new Error("--expect-sha256 must be a 64-character SHA-256 hex digest") };
  }
  return {
    ok: true,
    value: {
      action: action === "rollback" ? "rollback" : "apply",
      manifestPath: values.get("--manifest") ?? DEFAULT_MANIFEST_PATH,
      expectedSha256: expectedSha256?.toLowerCase() ?? null,
      indexPath: values.get("--index") ?? DB_PATH(),
      cataloguePath: values.get("--catalogue") ?? CATALOGUE_PATH(),
      operationId: values.get("--operation") ?? null,
      apply,
    },
  };
}

function loadManifest(path: string, expectedSha256: string): { readonly ok: true; readonly value: { readonly manifest: HistoricalDetachedChildManifest; readonly sha256: string } } | { readonly ok: false; readonly error: Error } {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, error: new Error(`cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (sha256 !== expectedSha256) {
    return { ok: false, error: new Error(`manifest SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`) };
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(raw) as JsonValue;
  } catch (error) {
    return { ok: false, error: new Error(`manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const validated = validateHistoricalDetachedChildBackfillManifest(parsed);
  if (!validated.ok) return validated;
  return { ok: true, value: { manifest: validated.value, sha256 } };
}

function resolveTargets(
  proposals: readonly HistoricalDetachedChildBackfillProposal[],
  indexPath: string,
): { readonly ok: true; readonly value: { readonly targets: readonly HistoricalDetachedChildBackfillProposal[]; readonly aliases: ReadonlyMap<string, string> } } | { readonly ok: false; readonly error: Error } {
  const aliases = aliasesForIds(indexPath, proposals.flatMap((proposal) => [proposal.childSessionId, proposal.parentSessionId]));
  if (!aliases.ok) return aliases;
  const targets: HistoricalDetachedChildBackfillProposal[] = [];
  const seenChildren = new Set<string>();
  for (const proposal of proposals) {
    const childSessionId = aliases.value.get(proposal.childSessionId);
    const parentSessionId = aliases.value.get(proposal.parentSessionId);
    if (!childSessionId || !parentSessionId) {
      return { ok: false, error: new Error(`index no longer resolves exact proposal ${proposal.childSessionId} → ${proposal.parentSessionId}`) };
    }
    if (childSessionId === parentSessionId) {
      return { ok: false, error: new Error(`canonicalized self-parenting proposal: ${childSessionId}`) };
    }
    if (seenChildren.has(childSessionId)) {
      return { ok: false, error: new Error(`two report identifiers resolve to child ${childSessionId}`) };
    }
    seenChildren.add(childSessionId);
    targets.push({ ...proposal, childSessionId, parentSessionId });
  }
  return { ok: true, value: { targets: targets.sort((left, right) => left.childSessionId.localeCompare(right.childSessionId)), aliases: aliases.value } };
}

function aliasesForIds(indexPath: string, rawIds: readonly string[]): { readonly ok: true; readonly value: ReadonlyMap<string, string> } | { readonly ok: false; readonly error: Error } {
  if (!existsSync(indexPath)) return { ok: false, error: new Error(`index not found: ${indexPath}`) };
  const requested = [...new Set(rawIds)].sort();
  let db: Database;
  try {
    db = new Database(indexPath, { readonly: true });
  } catch (error) {
    return { ok: false, error: new Error(`cannot open index ${indexPath}: ${error instanceof Error ? error.message : String(error)}`) };
  }
  try {
    const matches: IndexedSession[] = [];
    for (const chunk of chunks(requested, MAX_SQL_BINDINGS)) {
      const bound = bindIn(chunk, "id");
      matches.push(...db.query(
        `SELECT session_id AS sessionId, resume_id AS resumeId FROM sessions
          WHERE session_id IN (${bound.placeholders}) OR resume_id IN (${bound.placeholders})`,
      ).all(bound.values) as IndexedSession[]);
    }
    const canonicalByAlias = new Map<string, Set<string>>();
    for (const row of matches) {
      addAlias(canonicalByAlias, row.sessionId, row.sessionId);
      if (row.resumeId) addAlias(canonicalByAlias, row.resumeId, row.sessionId);
    }
    const resolved = new Map<string, string>();
    for (const rawId of requested) {
      const matchesForId = canonicalByAlias.get(rawId);
      if (matchesForId === undefined || matchesForId.size === 0) {
        return { ok: false, error: new Error(`index has no session_id/resume_id match for ${rawId}`) };
      }
      if (matchesForId.size !== 1) {
        return { ok: false, error: new Error(`index has ambiguous session_id/resume_id matches for ${rawId}`) };
      }
      resolved.set(rawId, [...matchesForId][0]!);
    }
    // Retain every discovered alias for conflict checks against already-written legacy parent IDs.
    for (const [alias, ids] of canonicalByAlias) if (ids.size === 1) resolved.set(alias, [...ids][0]!);
    return { ok: true, value: resolved };
  } catch (error) {
    return { ok: false, error: new Error(`cannot resolve index aliases: ${error instanceof Error ? error.message : String(error)}`) };
  } finally {
    db.close();
  }
}

function readCurrentStates(
  cataloguePath: string,
  sessionIds: readonly string[],
): { readonly ok: true; readonly value: ReadonlyMap<string, CurrentSessionState> } | { readonly ok: false; readonly error: Error } {
  if (!existsSync(cataloguePath)) return { ok: true, value: emptyStates(sessionIds) };
  let db: Database;
  try {
    db = new Database(cataloguePath, { readonly: true });
  } catch (error) {
    return { ok: false, error: new Error(`cannot open catalogue ${cataloguePath}: ${error instanceof Error ? error.message : String(error)}`) };
  }
  try {
    return { ok: true, value: readCurrentStatesFromDatabase(db, sessionIds) };
  } catch (error) {
    return { ok: false, error: new Error(`cannot inspect catalogue: ${error instanceof Error ? error.message : String(error)}`) };
  } finally {
    db.close();
  }
}

function readCurrentStatesFromDatabase(db: Database, sessionIds: readonly string[]): ReadonlyMap<string, CurrentSessionState> {
  const rows = new Map<string, {
    readonly sessionClass: string | null;
    readonly parentSessionId: string | null;
    readonly meta: string | null;
    readonly resumeId: string | null;
    readonly customTitle: string | null;
    readonly completed: number;
    readonly archived: number;
    readonly parkedTaskId: string | null;
    readonly notes: string | null;
    readonly identityKey: string | null;
    readonly substrate: string | null;
    readonly launcherIdentity: string | null;
  }>();
  for (const chunk of chunks([...new Set(sessionIds)].sort(), MAX_SQL_BINDINGS)) {
    const bound = bindIn(chunk, "id");
    const found = db.query(
      `SELECT session_id AS sessionId, session_class AS sessionClass, parent_session_id AS parentSessionId, meta,
              resume_id AS resumeId, custom_title AS customTitle, completed, archived,
              parked_task_id AS parkedTaskId, notes, identity_key AS identityKey,
              substrate, launcher_identity AS launcherIdentity
         FROM catalogue WHERE session_id IN (${bound.placeholders})`,
    ).all(bound.values) as Array<{
      sessionId: string;
      sessionClass: string | null;
      parentSessionId: string | null;
      meta: string | null;
      resumeId: string | null;
      customTitle: string | null;
      completed: number;
      archived: number;
      parkedTaskId: string | null;
      notes: string | null;
      identityKey: string | null;
      substrate: string | null;
      launcherIdentity: string | null;
    }>;
    for (const row of found) rows.set(row.sessionId, row);
  }
  const tagsById = new Map<string, string[]>();
  for (const chunk of chunks([...new Set(sessionIds)].sort(), MAX_SQL_BINDINGS)) {
    const bound = bindIn(chunk, "id");
    const found = db.query(
      `SELECT session_id AS sessionId, entity FROM session_tags WHERE session_id IN (${bound.placeholders}) ORDER BY entity`,
    ).all(bound.values) as Array<{ sessionId: string; entity: string }>;
    for (const row of found) {
      const tags = tagsById.get(row.sessionId) ?? [];
      tags.push(row.entity);
      tagsById.set(row.sessionId, tags);
    }
  }
  const states = new Map<string, CurrentSessionState>();
  for (const sessionId of sessionIds) {
    const row = rows.get(sessionId);
    const tags = tagsById.get(sessionId) ?? [];
    if (row === undefined) {
      if (tags.length > 0) throw new Error(`session ${sessionId} has tags but no catalogue row`);
      states.set(sessionId, {
        exists: false,
        sessionClass: null,
        parentSessionId: null,
        tags: [],
        provenancePresent: false,
        provenance: null,
        meta: {},
        unmanagedFieldsClear: true,
      });
      continue;
    }
    if (row.sessionClass !== null && row.sessionClass !== "work_body" && row.sessionClass !== "auxiliary") {
      throw new Error(`session ${sessionId} has invalid session_class ${row.sessionClass}`);
    }
    const meta = parseMeta(row.meta, sessionId);
    const provenancePresent = Object.hasOwn(meta, HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY);
    states.set(sessionId, {
      exists: true,
      sessionClass: row.sessionClass,
      parentSessionId: row.parentSessionId,
      tags,
      provenancePresent,
      provenance: provenancePresent ? meta[HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY]! : null,
      meta,
      unmanagedFieldsClear: row.resumeId === null
        && row.customTitle === null
        && row.completed === 0
        && row.archived === 0
        && row.parkedTaskId === null
        && row.notes === null
        && row.identityKey === null
        && row.substrate === null
        && row.launcherIdentity === null,
    });
  }
  return states;
}

function buildActions(
  targets: readonly HistoricalDetachedChildBackfillProposal[],
  states: ReadonlyMap<string, CurrentSessionState>,
  aliases: ReadonlyMap<string, string>,
  manifestSha256: string,
): { readonly ok: true; readonly value: readonly BackfillAction[] } | { readonly ok: false; readonly error: Error } {
  const actions: BackfillAction[] = [];
  for (const target of targets) {
    const before = states.get(target.childSessionId);
    if (before === undefined) return { ok: false, error: new Error(`missing catalogue state for ${target.childSessionId}`) };
    if (before.sessionClass !== null && before.sessionClass !== "auxiliary") {
      return { ok: false, error: new Error(`refusing ${target.childSessionId}: current class is ${before.sessionClass}, not null/auxiliary`) };
    }
    const canonicalExistingParent = before.parentSessionId === null ? null : aliases.get(before.parentSessionId) ?? before.parentSessionId;
    if (canonicalExistingParent !== null && canonicalExistingParent !== target.parentSessionId) {
      return { ok: false, error: new Error(`refusing ${target.childSessionId}: current parent ${before.parentSessionId} conflicts with reviewed parent ${target.parentSessionId}`) };
    }
    const provenance: BackfillProvenance = {
      version: 1,
      manifestSha256,
      findingIndex: target.findingIndex,
      causalParentSessionId: target.parentSessionId,
      evidence: target.evidence,
    };
    if (before.provenancePresent && !sameProvenance(before.provenance, provenance)) {
      return { ok: false, error: new Error(`refusing ${target.childSessionId}: existing historical provenance differs from this reviewed manifest`) };
    }
    actions.push({
      childSessionId: target.childSessionId,
      parentSessionId: target.parentSessionId,
      before,
      tagsToAdd: target.tags.filter((tag) => !before.tags.includes(tag)),
      provenance,
    });
  }
  return { ok: true, value: actions };
}

function applyAction(db: Database, action: BackfillAction, now: string): void {
  ensureRow(db, action.childSessionId, now);
  if (action.before.sessionClass !== "auxiliary") setSessionClass(db, action.childSessionId, "auxiliary", now);
  if (action.before.parentSessionId !== action.parentSessionId) setParent(db, action.childSessionId, action.parentSessionId, now);
  for (const tag of action.tagsToAdd) addTag(db, action.childSessionId, tag);
  if (!action.before.provenancePresent) {
    setMeta(db, action.childSessionId, HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY, action.provenance, now);
  }
}

function restoreAction(db: Database, entry: BackfillSnapshotEntry, now: string): void {
  setParent(db, entry.childSessionId, entry.before.parentSessionId, now);
  setSessionClass(db, entry.childSessionId, entry.before.sessionClass, now);
  for (const tag of entry.tagsAdded) removeTag(db, entry.childSessionId, tag);
  setMeta(
    db,
    entry.childSessionId,
    HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY,
    entry.before.provenancePresent ? entry.before.provenance : null,
    now,
  );
  if (!entry.before.exists) {
    // This removes only the metadata placeholder minted by this operation, never a transcript
    // or an independently authored catalogue row. The DB helper re-checks that nothing else
    // remains before deleting, so a later user write rolls the transaction back instead.
    deleteHistoricalDetachedChildBackfillPlaceholder(db, entry.childSessionId);
  }
}

function rollbackConflicts(
  snapshot: BackfillSnapshot,
  states: ReadonlyMap<string, CurrentSessionState>,
  aliases: ReadonlyMap<string, string>,
): readonly string[] {
  const conflicts: string[] = [];
  for (const entry of snapshot.entries) {
    const state = states.get(entry.childSessionId);
    if (state === undefined || !state.exists) {
      conflicts.push(`${entry.childSessionId} is missing from catalogue`);
      continue;
    }
    const canonicalParent = state.parentSessionId === null ? null : aliases.get(state.parentSessionId) ?? state.parentSessionId;
    if (state.sessionClass !== "auxiliary" || canonicalParent !== entry.parentSessionId) {
      conflicts.push(`${entry.childSessionId} class/parent changed since operation`);
    }
    if (!state.provenancePresent || !sameProvenance(state.provenance, entry.provenance)) {
      conflicts.push(`${entry.childSessionId} historical provenance changed since operation`);
    }
    for (const tag of entry.tagsAdded) {
      if (!state.tags.includes(tag)) conflicts.push(`${entry.childSessionId} no longer has operation-added tag ${tag}`);
    }
    if (!entry.before.exists && !isUntouchedCreatedPlaceholder(state, entry)) {
      conflicts.push(`${entry.childSessionId} has state beyond this operation and cannot be deleted on rollback`);
    }
  }
  return conflicts;
}

function parseSnapshot(raw: string, operationId: string): { readonly ok: true; readonly value: BackfillSnapshot } | { readonly ok: false; readonly error: Error } {
  let value: JsonValue;
  try {
    value = JSON.parse(raw) as JsonValue;
  } catch (error) {
    return { ok: false, error: new Error(`audit snapshot is invalid JSON: ${error instanceof Error ? error.message : String(error)}`) };
  }
  if (!isObject(value) || value.version !== 1 || value.operationId !== operationId || !Array.isArray(value.entries)
    || typeof value.manifestSha256 !== "string" || typeof value.manifestPath !== "string" || typeof value.appliedAt !== "string") {
    return { ok: false, error: new Error("audit snapshot has an invalid shape") };
  }
  const entries: BackfillSnapshotEntry[] = [];
  for (const [index, rawEntry] of value.entries.entries()) {
    const entry = parseSnapshotEntry(rawEntry, index);
    if (!entry.ok) return entry;
    entries.push(entry.value);
  }
  return {
    ok: true,
    value: {
      version: 1,
      operationId,
      manifestSha256: value.manifestSha256,
      manifestPath: value.manifestPath,
      appliedAt: value.appliedAt,
      entries,
    },
  };
}

function parseSnapshotEntry(value: JsonValue, index: number): { readonly ok: true; readonly value: BackfillSnapshotEntry } | { readonly ok: false; readonly error: Error } {
  if (!isObject(value) || typeof value.childSessionId !== "string" || typeof value.parentSessionId !== "string"
    || !isObject(value.before) || !Array.isArray(value.tagsAdded) || !value.tagsAdded.every((tag) => typeof tag === "string")
    || !isObject(value.provenance)) {
    return { ok: false, error: new Error(`audit snapshot entry ${index} has an invalid shape`) };
  }
  const before = parseCurrentState(value.before, `audit snapshot entry ${index}`);
  if (!before.ok) return before;
  const provenance = parseProvenance(value.provenance, `audit snapshot entry ${index}`);
  if (!provenance.ok) return provenance;
  return {
    ok: true,
    value: {
      childSessionId: value.childSessionId,
      parentSessionId: value.parentSessionId,
      before: before.value,
      tagsAdded: [...value.tagsAdded],
      provenance: provenance.value,
    },
  };
}

function parseCurrentState(value: { readonly [key: string]: JsonValue }, label: string): { readonly ok: true; readonly value: BackfillPreimage } | { readonly ok: false; readonly error: Error } {
  if (typeof value.exists !== "boolean" || !isSessionClass(value.sessionClass) || !isNullableString(value.parentSessionId)
    || !Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")
    || typeof value.provenancePresent !== "boolean" || !("provenance" in value)) {
    return { ok: false, error: new Error(`${label} has an invalid preimage`) };
  }
  return {
    ok: true,
    value: {
      exists: value.exists,
      sessionClass: value.sessionClass,
      parentSessionId: value.parentSessionId,
      tags: [...value.tags],
      provenancePresent: value.provenancePresent,
      provenance: value.provenance,
    },
  };
}

function parseProvenance(value: { readonly [key: string]: JsonValue }, label: string): { readonly ok: true; readonly value: BackfillProvenance } | { readonly ok: false; readonly error: Error } {
  if (value.version !== 1 || typeof value.manifestSha256 !== "string" || !isInteger(value.findingIndex)
    || typeof value.causalParentSessionId !== "string" || !isObject(value.evidence)) {
    return { ok: false, error: new Error(`${label} has invalid provenance`) };
  }
  const evidence = value.evidence;
  if (typeof evidence.promptHash !== "string" || typeof evidence.parentTranscriptPath !== "string"
    || !isInteger(evidence.parentLine) || typeof evidence.launchTimestamp !== "string"
    || !isNullableString(evidence.candidateTranscriptPath) || !isNullableString(evidence.candidateTimestamp)
    || !isMatchDimensionArray(evidence.matchedDimensions)) {
    return { ok: false, error: new Error(`${label} has invalid provenance evidence`) };
  }
  return {
    ok: true,
    value: {
      version: 1,
      manifestSha256: value.manifestSha256,
      findingIndex: value.findingIndex,
      causalParentSessionId: value.causalParentSessionId,
      evidence: {
        promptHash: evidence.promptHash,
        parentTranscriptPath: evidence.parentTranscriptPath,
        parentLine: evidence.parentLine,
        launchTimestamp: evidence.launchTimestamp,
        candidateTranscriptPath: evidence.candidateTranscriptPath,
        candidateTimestamp: evidence.candidateTimestamp,
        matchedDimensions: [...evidence.matchedDimensions],
      },
    },
  };
}

function requiresWrite(action: BackfillAction): boolean {
  return action.before.sessionClass !== "auxiliary"
    || action.before.parentSessionId !== action.parentSessionId
    || action.tagsToAdd.length > 0
    || !action.before.provenancePresent;
}

function backfillPreimageOf(state: CurrentSessionState): BackfillPreimage {
  return {
    exists: state.exists,
    sessionClass: state.sessionClass,
    parentSessionId: state.parentSessionId,
    tags: state.tags,
    provenancePresent: state.provenancePresent,
    provenance: state.provenance,
  };
}

function isUntouchedCreatedPlaceholder(state: CurrentSessionState, entry: BackfillSnapshotEntry): boolean {
  return state.unmanagedFieldsClear
    && sameStrings(state.tags, entry.tagsAdded)
    && Object.keys(state.meta).length === 1
    && sameProvenance(state.meta[HISTORICAL_DETACHED_CHILD_BACKFILL_META_KEY] ?? null, entry.provenance);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function sameActions(left: readonly BackfillAction[], right: readonly BackfillAction[]): boolean {
  return left.length === right.length && left.every((action, index) => {
    const other = right[index];
    return other !== undefined
      && action.childSessionId === other.childSessionId
      && action.parentSessionId === other.parentSessionId
      && sameCurrentState(action.before, other.before)
      && action.tagsToAdd.length === other.tagsToAdd.length
      && action.tagsToAdd.every((tag, tagIndex) => tag === other.tagsToAdd[tagIndex])
      && sameProvenance(provenanceJson(action.provenance), other.provenance);
  });
}

function sameCurrentState(left: CurrentSessionState, right: CurrentSessionState): boolean {
  return left.exists === right.exists
    && left.sessionClass === right.sessionClass
    && left.parentSessionId === right.parentSessionId
    && left.provenancePresent === right.provenancePresent
    && sameJson(left.provenance, right.provenance)
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}

function sameProvenance(left: JsonValue, right: BackfillProvenance): boolean {
  return sameJson(left, provenanceJson(right));
}

function provenanceJson(provenance: BackfillProvenance): JsonValue {
  return {
    version: provenance.version,
    manifestSha256: provenance.manifestSha256,
    findingIndex: provenance.findingIndex,
    causalParentSessionId: provenance.causalParentSessionId,
    evidence: {
      promptHash: provenance.evidence.promptHash,
      parentTranscriptPath: provenance.evidence.parentTranscriptPath,
      parentLine: provenance.evidence.parentLine,
      launchTimestamp: provenance.evidence.launchTimestamp,
      candidateTranscriptPath: provenance.evidence.candidateTranscriptPath,
      candidateTimestamp: provenance.evidence.candidateTimestamp,
      matchedDimensions: [...provenance.evidence.matchedDimensions],
    },
  };
}

function emptyStates(sessionIds: readonly string[]): ReadonlyMap<string, CurrentSessionState> {
  return new Map(sessionIds.map((sessionId) => [sessionId, {
    exists: false,
    sessionClass: null,
    parentSessionId: null,
    tags: [],
    provenancePresent: false,
    provenance: null,
    meta: {},
    unmanagedFieldsClear: true,
  }]));
}

function parseMeta(raw: string | null, sessionId: string): { readonly [key: string]: JsonValue } {
  if (raw === null || raw === "") return {};
  let value: JsonValue;
  try {
    value = JSON.parse(raw) as JsonValue;
  } catch (error) {
    throw new Error(`session ${sessionId} has invalid meta JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(value)) throw new Error(`session ${sessionId} meta is not an object`);
  return value;
}

function printApplySummary(args: BackfillArgs, sha256: string, proposalCount: number, pending: number, alreadyApplied: number): void {
  console.log(`historical detached-child backfill (${args.apply ? "APPLY" : "DRY-RUN"})`);
  console.log(`  manifest: ${args.manifestPath}`);
  console.log(`  sha256: ${sha256}`);
  console.log(`  exact proposals: ${proposalCount}`);
  console.log(`  metadata assignments to write: ${pending}`);
  console.log(`  already exact/idempotent: ${alreadyApplied}`);
  console.log("  withheld findings: unchanged");
  console.log("  archive/delete operations: none");
  if (!args.apply) console.log("  dry run only — pass --apply with the same --expect-sha256 to write");
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function bindIn(values: readonly string[], prefix: string): { readonly placeholders: string; readonly values: Record<string, string> } {
  const bindings: Record<string, string> = {};
  const placeholders = values.map((value, index) => {
    const key = `$${prefix}${index}`;
    bindings[key] = value;
    return key;
  });
  return { placeholders: placeholders.join(", "), values: bindings };
}

function addAlias(values: Map<string, Set<string>>, alias: string, canonical: string): void {
  const matches = values.get(alias) ?? new Set<string>();
  matches.add(canonical);
  values.set(alias, matches);
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableString(value: JsonValue | undefined): value is string | null {
  return value === null || typeof value === "string";
}

function isMatchDimensionArray(value: JsonValue | undefined): value is readonly MatchDimension[] {
  return Array.isArray(value) && value.every((item) => item === "prompt" || item === "cwd" || item === "entrypoint"
    || item === "provider" || item === "model" || item === "timestamp");
}

function isSessionClass(value: JsonValue | undefined): value is SessionClass | null {
  return value === null || value === "work_body" || value === "auxiliary";
}

function isInteger(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

