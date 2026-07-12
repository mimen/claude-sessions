import type { CatalogueRow } from "./db.ts";
import { lifecycleOf } from "./db.ts";
import { workUnitKey } from "./spawn-contract.ts";
import { allRolesFromFiles } from "../roles/role-files.ts";

/**
 * The cluster map: a readable roll-up of a system's members grouped by role, so any
 * session (or a human) can see the whole cluster and how to reach each member. This
 * is the VIEW that makes a `system` a legible cluster — distinct from ccs's
 * parent-graph `tree` (our core sessions are deliberately parent-less peers, ADR-0006,
 * so tree can't show them together; membership is by `system`, and this renders it).
 *
 * Pure: takes already-resolved members, returns a structured map. The caller does the
 * catalogue/index reads + liveness probe and the printing.
 */

/** A cluster member with the facts the map shows. */
export interface ClusterMember {
  readonly sessionId: string;
  readonly role: string; // catalogue.skill, e.g. pr-watch-control / pr-agent / loop-designer
  readonly title: string | null; // custom_title (human label)
  readonly cwd: string | null;
  readonly resumeId: string | null;
  readonly gusWork: string | null;
  readonly prNumber: number | null;
  readonly prRepo: string | null;
  readonly lifecycle: string; // idle | parked | completed | archived
  readonly live: boolean;
}

export interface ClusterMap {
  readonly cluster: string;
  readonly counts: { total: number; core: number; fleet: number; live: number; retired: number };
  /** Members grouped: "core" (the star/support roles) then per-role fleet groups. Each
   * group shows one primary per work-unit; `folded` maps a primary's sessionId to the
   * older same-PR sibling sessions it stands in for (shown under it with --expand). */
  readonly groups: { role: string; kind: "core" | "fleet"; members: ClusterMember[]; folded: Map<string, ClusterMember[]> }[];
}

/** Legacy fallback set (ADR-0062): core-vs-fleet is now a DECLARED role property (`topology` in
 * role.toml), read via the role registry. This hardcoded set is consulted ONLY for a role whose
 * role.toml doesn't declare `topology` — pre-migration rows and the old command-name labels — so a
 * declared role never needs a ccs release to be recognized. Remove once every role declares topology. */
const LEGACY_CORE_ROLES = new Set([
  "control", "slack-scout", "eval", "concierge", "designer",
  // legacy labels kept so pre-rename rows still group: `scout` (pre slack-scout rename),
  // and the pre-ADR-0015 command-name labels:
  "scout",
  "pr-watch-control", "pr-watch-scout", "pr-watch-eval", "pr-watch-2", "loop-designer",
]);

/** role → declared topology, built once from the config tree (files-are-truth, ADR-0050). Lazily
 * memoized; a process reads role definitions rarely-changing within its lifetime. */
let topologyByRole: Map<string, string | null> | null = null;
function declaredTopology(role: string): string | null {
  if (!topologyByRole) {
    topologyByRole = new Map();
    try {
      for (const [name, def] of allRolesFromFiles()) topologyByRole.set(name, def.topology);
    } catch {
      /* config unreadable → empty map, falls back to the legacy set below */
    }
  }
  return topologyByRole.get(role) ?? null;
}

/** Is this role a CORE singleton (vs a FLEET worker)? Prefers the role's DECLARED topology
 * (role.toml, ADR-0062); falls back to the legacy hardcoded set only when undeclared. */
export function isCoreRole(role: string | null): boolean {
  if (!role) return false;
  const declared = declaredTopology(role);
  if (declared) return declared === "core";
  return LEGACY_CORE_ROLES.has(role);
}

/** Build a member view from a catalogue row + its index-resolved cwd/resumeId + liveness. */
export function toMember(
  row: CatalogueRow,
  cwd: string | null,
  resumeId: string | null,
  live: boolean,
): ClusterMember {
  return {
    sessionId: row.sessionId,
    role: row.role ?? "(unroled)",
    title: row.customTitle,
    cwd,
    resumeId,
    gusWork: row.gusWork,
    prNumber: row.prNumber,
    prRepo: row.prRepo,
    lifecycle: lifecycleOf(row),
    live,
  };
}

/** Group members into the cluster map: core roles first, then fleet roles, each sorted. */
export function buildClusterMap(cluster: string, members: ClusterMember[]): ClusterMap {
  const byRole = new Map<string, ClusterMember[]>();
  for (const m of members) {
    const list = byRole.get(m.role) ?? [];
    list.push(m);
    byRole.set(m.role, list);
  }
  const groups: ClusterMap["groups"] = [];
  // Core groups first (a stable, human-sensible order), then fleet roles alphabetically.
  // Core/fleet is decided by isCoreRole — the single source of truth — not a parallel list.
  const CORE_ORDER = ["control", "concierge", "slack-scout", "eval", "designer", "loop-designer",
    // legacy labels, in case a pre-retag session still carries one:
    "scout", "pr-watch-control", "pr-watch-2", "pr-watch-eval", "pr-watch-scout"];
  const coreRoles = [...byRole.keys()].filter((r) => isCoreRole(r));
  coreRoles.sort((a, b) => {
    const ia = CORE_ORDER.indexOf(a), ib = CORE_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (a < b ? -1 : 1);
  });
  for (const role of coreRoles) {
    const { primaries, folded } = foldByUnit(byRole.get(role)!);
    groups.push({ role, kind: "core", members: primaries, folded });
    byRole.delete(role);
  }
  for (const role of [...byRole.keys()].sort()) {
    const { primaries, folded } = foldByUnit(byRole.get(role)!);
    groups.push({ role, kind: "fleet", members: primaries, folded });
  }
  const counts = {
    total: members.length,
    core: members.filter((m) => isCoreRole(m.role)).length,
    fleet: members.filter((m) => !isCoreRole(m.role)).length,
    live: members.filter((m) => m.live).length,
    retired: members.filter((m) => m.lifecycle === "completed" || m.lifecycle === "archived").length,
  };
  return { cluster, counts, groups };
}

/** Live first, then by PR number / title for a stable, skimmable order. */
function sortMembers(ms: ClusterMember[]): ClusterMember[] {
  return [...ms].sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    const an = a.prNumber ?? Number.MAX_SAFE_INTEGER;
    const bn = b.prNumber ?? Number.MAX_SAFE_INTEGER;
    if (an !== bn) return an - bn;
    return (a.title ?? a.sessionId).localeCompare(b.title ?? b.sessionId);
  });
}

/** A PR/work-unit can span several sessions (build + rebase + diagnose). The map
 * shows ONE primary per unit (live wins, else first) and folds the rest into a
 * "+N older" note, mirroring resume's one-worker-per-unit rule. Returns the primary
 * members plus, per unit, how many siblings were folded. */
export interface FoldedGroup {
  role: string;
  kind: "core" | "fleet";
  members: ClusterMember[];
  folded: Map<string, number>; // sessionId of primary -> count of folded siblings
}

function unitKey(m: ClusterMember): string {
  // canonical join key (spawn-contract), with the keyless-session sid fallback for folding
  return workUnitKey(m) ?? `sid:${m.sessionId}`;
}

function foldByUnit(members: ClusterMember[]): { primaries: ClusterMember[]; folded: Map<string, ClusterMember[]> } {
  const byUnit = new Map<string, ClusterMember[]>();
  for (const m of members) {
    const k = unitKey(m);
    (byUnit.get(k) ?? byUnit.set(k, []).get(k)!).push(m);
  }
  const primaries: ClusterMember[] = [];
  const folded = new Map<string, ClusterMember[]>(); // primary sessionId -> the folded siblings
  for (const group of byUnit.values()) {
    // primary: a live one if any, else the first (already sorted live-first).
    const sorted = sortMembers(group);
    const primary = sorted[0];
    if (!primary) continue; // unit with no members can't happen, but satisfies strict null
    primaries.push(primary);
    if (sorted.length > 1) folded.set(primary.sessionId, sorted.slice(1));
  }
  return { primaries: sortMembers(primaries), folded };
}

/** Render the cluster map as skimmable text. With `expand`, folded older sibling
 * sessions are listed indented under their primary instead of a "(+N)" note. */
export function renderClusterMap(map: ClusterMap, expand = false): string {
  const dot = (m: ClusterMember): string =>
    m.lifecycle === "completed" ? "✔" : m.lifecycle === "archived" ? "▪" : m.live ? "●" : "○";
  const lines: string[] = [];
  const c = map.counts;
  lines.push(
    `cluster: ${map.cluster}  —  ${c.total} members (${c.core} core · ${c.fleet} fleet) · ${c.live} live · ${c.retired} retired`,
  );
  lines.push(`  ● live   ○ idle/not-open   ✔ completed   ▪ archived`);
  for (const g of map.groups) {
    lines.push("");
    lines.push(`  [${g.kind}] ${g.role}  (${g.members.length})`);
    for (const m of g.members) {
      const pr = m.prNumber ? `#${m.prNumber}` : m.gusWork ? m.gusWork : "";
      // The custom_title may already lead with the PR number (catalogue_sync used to
      // prefix it) — strip a leading "#<n> " so we don't render "#12120 #12120 …".
      let label = m.title ?? m.sessionId.slice(0, 8);
      if (pr && label.startsWith(pr + " ")) label = label.slice(pr.length + 1);
      const reach = m.cwd ? m.cwd.replace(process.env.HOME ?? "~", "~") : m.sessionId.slice(0, 8);
      const sibs = g.folded.get(m.sessionId) ?? [];
      const foldNote = sibs.length > 0 && !expand
        ? `  (+${sibs.length} older session${sibs.length > 1 ? "s" : ""}; --expand)` : "";
      lines.push(`    ${dot(m)} ${pr ? pr + " " : ""}${label}${foldNote}`);
      lines.push(`        ${m.sessionId.slice(0, 8)} · ${reach}`);
      if (expand) {
        for (const s of sibs) {
          const sreach = s.cwd ? s.cwd.replace(process.env.HOME ?? "~", "~") : s.sessionId.slice(0, 8);
          lines.push(`        ↳ ${dot(s)} ${s.sessionId.slice(0, 8)} · ${sreach}  (older ${s.lifecycle})`);
        }
      }
    }
  }
  return lines.join("\n");
}
