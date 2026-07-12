import { readClusterDoc, writeClusterDoc } from "./cluster-state.ts";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";

/**
 * Work-unit runtime state (ADR-0057): a "work-unit" is a first-class entity with a stable id.
 * PR/GUS/cwd/branch are ATTRIBUTES that attach to it, not its identity. A session references
 * its work-unit by FK (CatalogueRow.workUnitId), mirroring how it references a grouping.
 *
 * Stored per cluster at ~/.ccs/clusters/<cluster>/cluster/work-units.json (one doc, id-keyed),
 * via the same enveloped/atomic cluster-state store as groupings. The id is minted by the
 * platform (stable, opaque) when work starts — NOT derived from PR/GUS (that's the old model).
 * Dedup + lineage key on the id; a second spawn for the same real work reconnects by finding
 * the work-unit via an anchor attribute (PR/GUS lookup).
 */

export interface WorkUnit {
  /** The stable id minted at creation — THE identity (not derived; opaque e.g. wu_<short>). */
  id: string;
  /** The cluster this work-unit belongs to. */
  cluster: string;
  /** Attributes — any/all may be absent at creation, attached later. */
  prRepo: string | null;
  prNumber: number | null;
  prState: string | null;
  gusWork: string | null;
  /** Human-facing label/title for this work-unit. */
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** The doc shape: workUnitId -> WorkUnit. */
type WorkUnitsDoc = Record<string, WorkUnit>;

const DOC = "work-units";

function readAll(cluster: string): WorkUnitsDoc {
  const doc = readClusterDoc<WorkUnitsDoc>(ccsRuntimeRoot(), cluster, DOC);
  return doc?.data ?? {};
}

/** Read one work-unit, or null. */
export function getWorkUnit(cluster: string, id: string): WorkUnit | null {
  return readAll(cluster)[id] ?? null;
}

/** All work-units for a cluster (id -> WorkUnit). */
export function allWorkUnits(cluster: string): WorkUnitsDoc {
  return readAll(cluster);
}

/**
 * Mint a new work-unit with a stable, deterministic-where-possible id. The id is NOT purely
 * random (Date.now/Math.random) — it's derived from the anchor attributes if present (so the
 * same PR/GUS always mints the same id), or from an incrementing counter scan otherwise.
 * Returns the minted id.
 */
export function mintWorkUnit(
  cluster: string,
  attrs: {
    prRepo?: string | null;
    prNumber?: number | null;
    prState?: string | null;
    gusWork?: string | null;
    title?: string | null;
  },
  now: string,
  source = "cli",
): string {
  const all = readAll(cluster);

  // Derive a stable id from anchor attributes if present (PR or GUS)
  let id: string;
  if (attrs.prRepo && attrs.prNumber) {
    // Deterministic from PR: wu_<repo-slug>_<number>
    const repoSlug = attrs.prRepo.split("/").pop()?.replace(/[^a-z0-9]/gi, "") || "repo";
    id = `wu_${repoSlug}_${attrs.prNumber}`;
  } else if (attrs.gusWork) {
    // Deterministic from GUS: wu_<gus-id>
    const gusSlug = attrs.gusWork.replace(/[^a-z0-9]/gi, "");
    id = `wu_${gusSlug}`;
  } else {
    // No anchor — incrementing counter from existing ids
    const existing = Object.keys(all).filter((k) => k.startsWith("wu_anon_"));
    const nums = existing.map((k) => parseInt(k.replace("wu_anon_", ""), 10)).filter((n) => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    id = `wu_anon_${next}`;
  }

  // If the id already exists, return it (already minted)
  if (all[id]) return id;

  // Mint the new work-unit
  all[id] = {
    id,
    cluster,
    prRepo: attrs.prRepo ?? null,
    prNumber: attrs.prNumber ?? null,
    prState: attrs.prState ?? null,
    gusWork: attrs.gusWork ?? null,
    title: attrs.title ?? null,
    createdAt: now,
    updatedAt: now,
  };
  writeClusterDoc(ccsRuntimeRoot(), cluster, DOC, all, { now, source });
  return id;
}

/**
 * Find a work-unit by anchor attribute (PR or GUS). Returns the id, or null if not found.
 * This is the reconnection path: a fresh session for PR 123 looks up which work-unit has
 * prNumber=123, and reconnects to it by id (find-or-create, not re-derive-the-string).
 */
export function findWorkUnitByAnchor(
  cluster: string,
  anchor: { prRepo: string; prNumber: number } | { gusWork: string },
): string | null {
  const all = readAll(cluster);
  for (const [id, wu] of Object.entries(all)) {
    if ("prRepo" in anchor && "prNumber" in anchor) {
      if (wu.prRepo === anchor.prRepo && wu.prNumber === anchor.prNumber) return id;
    } else if ("gusWork" in anchor) {
      if (wu.gusWork === anchor.gusWork) return id;
    }
  }
  return null;
}

/**
 * Attach or update attributes on an existing work-unit (the PR/GUS/title attach path).
 * Attributes merge — only the provided fields are updated.
 */
export function attachAttributes(
  cluster: string,
  id: string,
  attrs: {
    prRepo?: string | null;
    prNumber?: number | null;
    prState?: string | null;
    gusWork?: string | null;
    title?: string | null;
  },
  now: string,
  source = "cli",
): void {
  const all = readAll(cluster);
  const prev = all[id];
  if (!prev) throw new Error(`work-unit ${id} not found in cluster ${cluster}`);

  all[id] = {
    ...prev,
    prRepo: attrs.prRepo !== undefined ? attrs.prRepo : prev.prRepo,
    prNumber: attrs.prNumber !== undefined ? attrs.prNumber : prev.prNumber,
    prState: attrs.prState !== undefined ? attrs.prState : prev.prState,
    gusWork: attrs.gusWork !== undefined ? attrs.gusWork : prev.gusWork,
    title: attrs.title !== undefined ? attrs.title : prev.title,
    updatedAt: now,
  };
  writeClusterDoc(ccsRuntimeRoot(), cluster, DOC, all, { now, source });
}
