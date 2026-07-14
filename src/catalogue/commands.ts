import { existsSync } from "node:fs";
import { ensureDataDir, CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import {
  openCatalogue,
  setCustomTitle,
  setCompleted,
  setArchived,
  setKey,
  setParent,
  setRole,
  setGusWork,
  setSessionEpic,
  setStage,
  setStatusLine,
  setMeta,
  setProject,
  setCluster,
  addTag,
  removeTag,
  childrenOf,
  getRow,
  getTags,
  identityKeyOf,
} from "./db.ts";
import { openIndex } from "../index/schema.ts";
import { titleOf, usageOf, subagentCostOf, type SessionUsage } from "../index/index.ts";
import { formatCost, formatTokens } from "../cost.ts";
import { pushCmuxRename } from "../cmux/liveness.ts";
import { resolveRole } from "../roles/role-files.ts";
import { validateStageTransition } from "./stage-schema.ts";
import { recomposeForSession } from "../board/recompose.ts";

/**
 * CLI surface for the catalogue. These are the primitives the in-session slash commands
 * (/session-rename, /session-loop, /session-tag, …) shell out to, and what `ccs` exposes
 * directly. Keep them dumb and composable.
 */

const now = (): string => new Date().toISOString();

/** A Claude Code session id is a UUID; used to validate a `parent` edge before storing it. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve the target session id: explicit arg, or "." / "self" / omitted → current session. */
function resolveSessionId(arg: string | undefined): string | null {
  if (!arg || arg === "." || arg === "self") return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  return arg;
}

/**
 * Resolve a session id to a short, human-skimmable label: `1a2b3c4d… <title>`. Opens the Index
 * read-only when present; degrades to the bare short id when the session isn't indexed (a forward
 * reference to a parent that hasn't been seen yet is allowed, so this must never throw).
 */
function labelFor(id: string): string {
  const short = `${id.slice(0, 8)}…`;
  if (!existsSync(DB_PATH())) return short;
  const db = openIndex(DB_PATH());
  try {
    const title = titleOf(db, id);
    return title ? `${short} ${title}` : short;
  } finally {
    db.close();
  }
}

export function whoami(): number {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) {
    console.error("Not inside a Claude Code session (CLAUDE_CODE_SESSION_ID unset).");
    return 1;
  }
  console.log(id);
  return 0;
}

export function rename(sessionArg: string | undefined, name: string | undefined): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  if (!name || !name.trim()) {
    console.error('usage: ccs rename [<session-id>|.] "<name>"');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setCustomTitle(db, id, name.trim(), now());
    const pushed = pushCmuxRename(id, name.trim());
    console.log(`renamed → ${name.trim()}${pushed ? " (cmux synced)" : " (cmux not open / not synced)"}`);
  } finally {
    db.close();
  }
  return 0;
}

export function mark(sessionArg: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  const changes: string[] = [];
  try {
    // ADR-0062: `--loop` (setKind) is retired — kind derives from the session's role now, not a
    // per-session flag. `ccs mark` handles lifecycle (completed/archived) only.
    if (flags.includes("--completed") || flags.includes("--complete")) {
      setCompleted(db, id, !off, now());
      changes.push(`completed=${!off}`);
    }
    if (flags.includes("--archived") || flags.includes("--archive")) {
      setArchived(db, id, !off, now());
      changes.push(`archived=${!off}`);
    }
    if (changes.length === 0) {
      console.error("usage: ccs mark [<session-id>|.] --completed|--archived [--off]");
      return 1;
    }
    console.log(`marked ${id.slice(0, 8)}… ${changes.join(" ")}`);
  } finally {
    db.close();
  }
  return 0;
}

export function tag(sessionArg: string | undefined, entity: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  if (!entity) {
    console.error('usage: ccs tag [<session-id>|.] "<Entity>" [--remove]');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    if (flags.includes("--remove")) {
      removeTag(db, id, entity);
      console.log(`untagged ${entity}`);
    } else {
      addTag(db, id, entity);
      console.log(`tagged ${entity} · now: ${getTags(db, id).join(", ")}`);
    }
  } finally {
    db.close();
  }
  return 0;
}

/** Set (or clear, with --off) the key (identity grouping slug) a session belongs to. */
export function key(sessionArg: string | undefined, slug: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!slug || !slug.trim())) {
    console.error('usage: ccs key [<session-id>|.] <slug> [--off]');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setKey(db, id, off ? null : slug!.trim(), now());
    console.log(off ? `cleared key on ${id.slice(0, 8)}…` : `key ${slug!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}


/**
 * `ccs status [<id>|.] "<freeform line>" | --off` — set a short freeform status a session writes
 * about ITSELF, shown on its tab (ONE line). Unlike `phase` (a controlled vocabulary → pill),
 * this is human-readable prose the agent authors. `--off` clears it. `value` is the full line
 * (the CLI joins the non-flag args), so it can be a sentence, not a single token.
 */
export function status(sessionArg: string | undefined, value: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!value || !value.trim())) {
    console.error('usage: ccs status [<session-id>|.] "<short freeform line>" | --off');
    return 1;
  }
  // Keep tabs readable: clamp to ONE line so the sidebar description never wraps. Newlines are
  // collapsed to spaces first so a two-line value truncates cleanly (rather than showing the first
  // line only). 50 chars is the visible budget in the sidebar at typical widths.
  const line = off ? null : value!.trim().replace(/\s+/g, " ").slice(0, 50);
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setStatusLine(db, id, line, now());
    console.log(off ? `cleared status on ${id.slice(0, 8)}…` : `status "${line}" → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  recomposeForSession(id);
  return 0;
}

/**
 * `ccs name [<id>|.] "<short name>" | --off` — set a session's short DISPLAY name (`meta.shortname`),
 * the tab title's label after the "#<PR> " prefix. Kept separate from `custom_title` because the
 * cluster's catalogue_sync overwrites custom_title with the full PR title each tick; the shortname
 * is the worker's own stable label and must survive that. Clamped to 35ch so the tab stays readable.
 */
export function name(sessionArg: string | undefined, value: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!value || !value.trim())) {
    console.error('usage: ccs name [<session-id>|.] "<short name (<=35ch)>" | --off');
    return 1;
  }
  const short = off ? null : value!.trim().replace(/\s+/g, " ").slice(0, 35);
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setMeta(db, id, "shortname", short, now());
    console.log(off ? `cleared name on ${id.slice(0, 8)}…` : `name "${short}" → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}


/**
 * `ccs stage` — the GENERIC stage setter. D5 (2026-07-14): after the phase-first board
 * (ADR-0077) made the cluster's composed board the source of stage truth, the catalogue.stage
 * column is a CACHE the sensor writes for rendering — not part of the state machine. This
 * command therefore refuses writes without `--sensor <source>`, making the enforced discipline
 * "stage is engine-computed, not self-declared" (the pr-watch constitution's "Lifecycle is
 * control's, not yours" rule) into a mechanical guarantee.
 *
 * The old "worker runs ccs stage . milad-review" path is dead — a Milad approval is expressed
 * via `meta.milad_review = "approved"` (which the sensor observes and latches into the board's
 * effective stage). Workers never write stage directly.
 *
 * Usage:
 *   ccs stage [<id>|.]                          # read (query-only, no flag)
 *   ccs stage [<id>|.] <value> --sensor <name>  # sensor write (catalogue_sync, migrations)
 *   ccs stage [<id>|.] --off --sensor <name>    # sensor clear
 *
 * A worker-side `ccs stage . <value>` returns exit 2 with a redirect message.
 */
export function stage(sessionArg: string | undefined, value: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  const v = value?.trim();
  const sensorIdx = flags.indexOf("--sensor");
  const sensor = sensorIdx >= 0 ? flags[sensorIdx + 1] : null;

  // Read mode: no value + no --off + no --sensor → print the current cached stage. Useful for
  // scripts + humans that just want to know "what does the catalogue think this session is at?".
  if (!off && !v && !sensor) {
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    try {
      const row = getRow(db, id);
      console.log(row?.stage ?? "");
    } finally {
      db.close();
    }
    return 0;
  }

  // Write mode: --sensor is required. Workers/humans can no longer bump stage.
  if (!sensor) {
    console.error(
      "ccs stage: writes require --sensor <name> (D5: stage is engine-computed).\n" +
      "  Workers do not set their own stage. The board's data.stage (composed by the cluster) is\n" +
      "  the source of truth; the catalogue column is a sensor-written render cache.\n" +
      "  For a Milad approval, set meta.milad_review=approved via the cluster's approve flow.",
    );
    return 2;
  }
  if (!off && !v) {
    console.error("usage: ccs stage [<id>|.] <value> --sensor <name>  (or --off --sensor <name>)");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    if (!off) {
      // ADR-0064 vocabulary/monotonic validation still applies to sensor writes — a bogus value
      // from a buggy sensor should fail loud, not silently poison the cache.
      const row = getRow(db, id);
      const schema = row?.role ? resolveRole(row.role, row.cluster)?.stageSchema ?? null : null;
      const err = validateStageTransition(schema, row?.stage ?? null, v!);
      if (err) {
        console.error(`ccs stage: ${err}`);
        return 1;
      }
    }
    setStage(db, id, off ? null : v!, now());
    console.log(
      off
        ? `cleared stage on ${id.slice(0, 8)}… (sensor=${sensor})`
        : `stage ${v} → ${id.slice(0, 8)}… (sensor=${sensor})`,
    );
  } finally {
    db.close();
  }
  recomposeForSession(id);
  return 0;
}

/**
 * `ccs meta [<id>|.] <key> <value> | <key> --off` — the GENERIC per-session metadata setter (ADR-0064).
 * Writes a key into the row's `meta` JSON map (ADR-0060). ccs stores + stamps it but does NOT interpret
 * it — the cluster/role decides what keys mean (miladReview, build_complete, locks, …). `--off` clears
 * the key. Distinct from the `meta` READ command (`ccs meta <id>` with no key). Value is JSON-parsed if
 * it looks like JSON (true/false/number/null), else stored as a string.
 */
export function metaSet(sessionArg: string | undefined, key: string | undefined, value: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!key || !key.trim()) {
    console.error("usage: ccs meta-set [<id>|.] <key> <value> | <key> --off");
    return 1;
  }
  if (!off && (value === undefined || value === "")) {
    console.error("usage: ccs meta-set [<id>|.] <key> <value> | <key> --off");
    return 1;
  }
  // Parse JSON-ish scalars (true/false/123/null/"..."); else keep the raw string.
  let parsed: unknown = value;
  if (!off && value !== undefined) {
    try { parsed = JSON.parse(value); } catch { parsed = value; }
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setMeta(db, id, key.trim(), off ? null : parsed, now());
    console.log(off ? `cleared meta.${key.trim()} on ${id.slice(0, 8)}…` : `meta.${key.trim()} = ${value} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  recomposeForSession(id);
  return 0;
}

/** Set (or clear, with --off) the parent session that spawned/owns this one. */
export function parent(
  sessionArg: string | undefined,
  parentArg: string | undefined,
  flags: string[],
): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    if (off) {
      setParent(db, id, null, now());
      console.log(`cleared parent on ${id.slice(0, 8)}…`);
      return 0;
    }
    const parentId = resolveSessionId(parentArg);
    if (!parentId) {
      console.error("usage: ccs parent [<session-id>|.] <parent-id|.> | --off");
      return 1;
    }
    if (parentId === id) {
      console.error("A session can't be its own parent.");
      return 1;
    }
    // Validate shape; a non-UUID is almost certainly a mistake (wrong arg order, a title, …).
    if (!SESSION_ID_RE.test(parentId)) {
      console.error(`Not a session id: ${parentId} (expected a UUID). Nothing set.`);
      return 1;
    }
    setParent(db, id, parentId, now());
    console.log(`parent ${parentId.slice(0, 8)}… → ${id.slice(0, 8)}…`);
    // Warn (don't fail) on a parent we've never indexed — forward references are allowed.
    if (existsSync(DB_PATH())) {
      const ix = openIndex(DB_PATH());
      try {
        if (titleOf(ix, parentId) === null) {
          console.warn(`  note: parent ${parentId.slice(0, 8)}… isn't in the index (forward reference — ok).`);
        }
      } finally {
        ix.close();
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

/** Set (or clear, with --off) the project/initiative label for this session. */
export function project(sessionArg: string | undefined, label: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!label || !label.trim())) {
    console.error('usage: ccs project [<session-id>|.] <label> [--off]');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setProject(db, id, off ? null : label!.trim(), now());
    console.log(off ? `cleared project on ${id.slice(0, 8)}…` : `project ${label!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** Set (or clear, with --off) the cluster grouping for this session. */
export function setClusterCmd(sessionArg: string | undefined, slug: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!slug || !slug.trim())) {
    console.error('usage: ccs set-cluster [<session-id>|.] <slug> [--off]');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setCluster(db, id, off ? null : slug!.trim(), now());
    console.log(off ? `cleared cluster on ${id.slice(0, 8)}…` : `cluster ${slug!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** ccs role [<id>|.] <role> [--off] — set the canonical role (ADR-0015). */
export function role(sessionArg: string | undefined, roleName: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!roleName || !roleName.trim())) {
    console.error("usage: ccs role [<session-id>|.] <role> [--off]");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setRole(db, id, off ? null : roleName!.trim().replace(/^\//, ""), now());
    console.log(off ? `cleared role on ${id.slice(0, 8)}…` : `role ${roleName!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** ccs gus-work [<id>|.] <W-number> [--off] — set the work-item id (ADR-0013). */
export function gusWork(sessionArg: string | undefined, w: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!w || !w.trim())) {
    console.error("usage: ccs gus-work [<session-id>|.] <W-number> [--off]");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setGusWork(db, id, off ? null : w!.trim(), now());
    console.log(off ? `cleared gus-work on ${id.slice(0, 8)}…` : `gus-work ${w!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** ccs epic [<id>|.] <epic-id> [--off] — point a session at its epic entity (FK). */
export function sessionEpic(sessionArg: string | undefined, groupingId: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!groupingId || !groupingId.trim())) {
    console.error("usage: ccs epic [<session-id>|.] <epic-id> [--off]");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    setSessionEpic(db, id, off ? null : groupingId!.trim(), now());
    console.log(off ? `cleared epic on ${id.slice(0, 8)}…` : `epic ${groupingId!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** Token/cost detail from the Index for one session, or null when unindexed. */
function usageFor(id: string): { usage: SessionUsage; subagentUSD: number } | null {
  if (!existsSync(DB_PATH())) return null;
  const db = openIndex(DB_PATH());
  try {
    const usage = usageOf(db, id);
    if (!usage) return null;
    return { usage, subagentUSD: subagentCostOf(db, id) };
  } finally {
    db.close();
  }
}

/** Print the current session's catalogue row (self-awareness). */
export function meta(sessionArg: string | undefined): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const cost = usageFor(id);
  const db = openCatalogue(CATALOGUE_PATH());
  try {
    const row = getRow(db, id);
    const tags = getTags(db, id);
    const children = childrenOf(db, id);
    if (!row && tags.length === 0 && children.length === 0 && !cost) {
      console.log(`${id}\n  (no catalogue metadata yet)`);
      return 0;
    }
    console.log(id);
    if (row?.customTitle) console.log(`  title: ${row.customTitle}`);
    console.log(`  kind: ${row?.kind ?? "session"}`);
    console.log(
      `  lifecycle: ${row?.archived ? "archived" : row?.completed ? "completed" : row?.parkedTaskId ? "parked" : "idle"}`,
    );
    if (row?.cluster) console.log(`  cluster: ${row.cluster}`);
    if (row?.role) console.log(`  role: ${row.role}`);
    if (row?.parentSessionId) console.log(`  parent: ${labelFor(row.parentSessionId)}`);
    if (children.length) {
      console.log(`  children: ${children.length}`);
      for (const c of children) console.log(`    ↳ ${labelFor(c)}`);
    }
    const keyValue = identityKeyOf(row);
    if (keyValue) console.log(`  key: ${keyValue}`);
    if (tags.length) console.log(`  tags: ${tags.join(", ")}`);
    if (cost && (cost.usage.costUSD > 0 || cost.subagentUSD > 0)) {
      const u = cost.usage;
      const sub = cost.subagentUSD > 0 ? ` (+ ${formatCost(cost.subagentUSD)} subagents)` : "";
      console.log(`  cost: ${formatCost(u.costUSD) || "$0.00"}${sub}`);
      console.log(
        `  tokens: in ${formatTokens(u.tokInput)} · out ${formatTokens(u.tokOutput)}` +
          ` · cache read ${formatTokens(u.tokCacheRead)} · cache write ${formatTokens(u.tokCacheWrite)}`,
      );
      const models = Object.entries(u.costByModel).sort((a, b) => b[1] - a[1]);
      if (models.length > 1) {
        for (const [model, usd] of models) {
          console.log(`    ${model}: ${formatCost(usd) || "$0.00"}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return 0;
}

function notInSession(): number {
  console.error("No session id (pass one, or run inside a Claude session for `.`).");
  return 1;
}
