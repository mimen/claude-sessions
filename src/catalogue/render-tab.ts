import type { CatalogueRow, Kind } from "./db.ts";
import { lifecycleOf, identityKeyOf } from "./db.ts";

/**
 * A tab's render ops: the full set of cmux workspace visual attrs we push.
 * Title/description/color/pill — a pure stateless projection of a catalogue row.
 */
export interface TabRenderOps {
  title: string;
  description: string | null;
  color: string | null;
  statusPill: StatusPill | null;
}

export interface StatusPill {
  key: string;
  label: string;
  icon?: string;
  color?: string;
  priority?: number;
}

/**
 * Pure renderer: map a catalogue row + kind to cmux workspace render ops.
 * Different templates by kind: session (worker/leaf PR work) vs loop (infra/core).
 */
export function renderTab(row: CatalogueRow, kind: Kind): TabRenderOps {
  if (kind === "loop") {
    return renderLoop(row);
  }
  return renderSession(row);
}

function renderSession(row: CatalogueRow): TabRenderOps {
  const title = buildSessionTitle(row);
  const description = buildSessionDescription(row);
  const color = computeSessionColor(row);
  const statusPill = computeLifecyclePill(row);
  return { title, description, color, statusPill };
}

function renderLoop(row: CatalogueRow): TabRenderOps {
  // role is the canonical label (ADR-0015); skill is dead. A loop's tab reads best as its
  // role name (control/scout/eval), falling back to custom title / key / id.
  const title =
    row.customTitle || row.role || row.skill || identityKeyOf(row) || row.sessionId.slice(0, 8);
  const description = buildLoopDescription(row);
  const color = "Purple";
  const statusPill = computeLifecyclePill(row);
  return { title, description, color, statusPill };
}

/** Strip any leading "#<num> " groups so the PR# is never baked into the name — the
 * renderer composes it once from prNumber. Guards against dirty stored titles that
 * already carry the prefix (which would otherwise double/triple: "#12133 #12133 …"). */
function stripPrPrefix(title: string): string {
  return title.replace(/^(#\d+\s+)+/, "");
}

function buildSessionTitle(row: CatalogueRow): string {
  const clean = row.customTitle ? stripPrPrefix(row.customTitle) : null;
  if (row.prNumber && clean) {
    return `#${row.prNumber} ${clean}`;
  }
  if (clean) {
    return clean;
  }
  const key = identityKeyOf(row);
  if (key) return key;
  if (row.role) return row.role; // a role-tagged session with no title reads as its role
  return row.sessionId.slice(0, 8);
}

function buildSessionDescription(row: CatalogueRow): string | null {
  const parts: string[] = [];
  if (row.system) parts.push(row.system);
  const key = identityKeyOf(row);
  if (key) parts.push(key);
  if (row.project) parts.push(row.project);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function buildLoopDescription(row: CatalogueRow): string | null {
  const parts: string[] = [];
  if (row.system) parts.push(row.system);
  const key = identityKeyOf(row);
  if (key) parts.push(key);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function computeSessionColor(row: CatalogueRow): string | null {
  const lc = lifecycleOf(row);
  if (lc === "archived") return "Charcoal";
  if (lc === "completed") return "Green";
  if (lc === "parked") return "Amber";
  if (row.prState === "open") return "Aqua";
  if (row.prState === "merged") return "Green";
  if (row.prState === "closed") return "Charcoal";
  return null;
}

function computeLifecyclePill(row: CatalogueRow): StatusPill | null {
  const lc = lifecycleOf(row);
  if (lc === "idle") return null;
  const labels: Record<string, string> = {
    parked: "parked",
    completed: "done",
    archived: "archived",
  };
  const label = labels[lc];
  if (!label) return null;
  return {
    key: "ccs_lifecycle",
    label,
    priority: 50,
  };
}
