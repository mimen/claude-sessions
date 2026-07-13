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
  readonly groupingId: string | null; // the epic/grouping FK — for metadata-gap detection
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

/** role → declared work-unit anchor type, built once from the config tree (files-are-truth,
 * ADR-0050). Lazily memoized; role definitions rarely change within a process lifetime. */
let anchorByRole: Map<string, string | null> | null = null;
function declaredAnchor(role: string): string | null {
  if (!anchorByRole) {
    anchorByRole = new Map();
    try {
      for (const [name, def] of allRolesFromFiles()) anchorByRole.set(name, def.workUnit);
    } catch {
      /* config unreadable → empty map, falls back to the legacy set below */
    }
  }
  return anchorByRole.get(role) ?? null;
}

/** Is this role a CORE singleton (vs a FLEET worker)? Fleet-ness DERIVES from the declared
 * work-unit anchor type (ADR-0069): `none` ⇒ core, any other anchor ⇒ fleet. Falls back to the
 * legacy hardcoded set only for a role that declares no anchor (pre-migration / old labels). */
export function isCoreRole(role: string | null): boolean {
  if (!role) return false;
  const anchor = declaredAnchor(role);
  if (anchor) return anchor === "none";
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
    groupingId: row.groupingId,
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

/** One member in the JSON projection — the agent-facing roster row. */
export interface ClusterMemberJson {
  sessionId: string;
  role: string;
  kind: "core" | "fleet";
  title: string | null;
  live: boolean;
  lifecycle: string; // idle | parked | completed | archived
  prNumber: number | null;
  prRepo: string | null;
  gusWork: string | null;
  groupingId: string | null;
  cwd: string | null;
  resumeId: string | null;
  /** True when this member is the shown PRIMARY for its work-unit and stands in for older
   * siblings (their ids are in `folds`). */
  folds: string[];
}

/**
 * Machine-readable projection of the cluster map (`ccs cluster <c> --json`), for AGENTS to consume
 * their roster deterministically each tick instead of grep-parsing the rendered tree. Flattens the
 * `folded` Map into per-member `folds[]`, and adds a `needsAttention` roll-up: closed sessions that
 * hold IN-FLIGHT work (not retired, not live) — the "work won't get done unless reopened" signal a
 * control loop can surface. Pure — same inputs as renderClusterMap.
 */
export function clusterMapToJson(map: ClusterMap): {
  cluster: string;
  counts: ClusterMap["counts"];
  members: ClusterMemberJson[];
  /** Fleet members that are NOT live and NOT retired — in-flight work with no running session. */
  closedWithWork: ClusterMemberJson[];
  /** Non-retired fleet members MISSING metadata a sensor should have filled — no gusWork (the
   * work-item) or no groupingId (the epic). A control loop surfaces/backfills these agentically
   * (the born-with-PR-facts, epic-attached-later gap; ADR-0027/0076). */
  metadataGaps: Array<ClusterMemberJson & { missing: string[] }>;
} {
  const members: ClusterMemberJson[] = [];
  for (const g of map.groups) {
    for (const m of g.members) {
      members.push({
        sessionId: m.sessionId, role: m.role, kind: g.kind, title: m.title,
        live: m.live, lifecycle: m.lifecycle, prNumber: m.prNumber, prRepo: m.prRepo,
        gusWork: m.gusWork, groupingId: m.groupingId, cwd: m.cwd, resumeId: m.resumeId,
        folds: (g.folded.get(m.sessionId) ?? []).map((s) => s.sessionId),
      });
    }
  }
  const active = (m: ClusterMemberJson) =>
    m.kind === "fleet" && m.lifecycle !== "completed" && m.lifecycle !== "archived";
  const closedWithWork = members.filter((m) => active(m) && !m.live);
  const metadataGaps = members
    .filter(active)
    .map((m) => {
      const missing: string[] = [];
      if (!m.gusWork) missing.push("gusWork");
      if (!m.groupingId) missing.push("groupingId");
      return { ...m, missing };
    })
    .filter((m) => m.missing.length > 0);
  return { cluster: map.cluster, counts: map.counts, members, closedWithWork, metadataGaps };
}
