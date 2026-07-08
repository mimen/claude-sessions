import { existsSync } from "node:fs";
import { ensureDataDir, CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import {
  openCatalogue,
  setCustomTitle,
  setKind,
  setCompleted,
  setArchived,
  setKey,
  setParent,
  setSkill,
  setProject,
  setSystem,
  addTag,
  removeTag,
  childrenOf,
  getRow,
  getTags,
  identityKeyOf,
  type Kind,
} from "./db.ts";
import { openIndex } from "../index/schema.ts";
import { titleOf, usageOf, subagentCostOf, type SessionUsage } from "../index/index.ts";
import { formatCost, formatTokens } from "../cost.ts";
import { pushCmuxRename } from "./open-state.ts";

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
  if (!existsSync(DB_PATH)) return short;
  const db = openIndex(DB_PATH);
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
  const db = openCatalogue(CATALOGUE_PATH);
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
  const db = openCatalogue(CATALOGUE_PATH);
  const changes: string[] = [];
  try {
    if (flags.includes("--loop")) {
      const kind: Kind = off ? "session" : "loop";
      setKind(db, id, kind, now());
      changes.push(`kind=${kind}`);
    }
    if (flags.includes("--completed") || flags.includes("--complete")) {
      setCompleted(db, id, !off, now());
      changes.push(`completed=${!off}`);
    }
    if (flags.includes("--archived") || flags.includes("--archive")) {
      setArchived(db, id, !off, now());
      changes.push(`archived=${!off}`);
    }
    if (changes.length === 0) {
      console.error("usage: ccs mark [<session-id>|.] --loop|--completed|--archived [--off]");
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
  const db = openCatalogue(CATALOGUE_PATH);
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
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    setKey(db, id, off ? null : slug!.trim(), now());
    console.log(off ? `cleared key on ${id.slice(0, 8)}…` : `key ${slug!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/**
 * @deprecated Use `key()` instead. This alias writes to `key` for backward compatibility.
 */
export function event(sessionArg: string | undefined, slug: string | undefined, flags: string[]): number {
  return key(sessionArg, slug, flags);
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
  const db = openCatalogue(CATALOGUE_PATH);
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
    if (existsSync(DB_PATH)) {
      const ix = openIndex(DB_PATH);
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

/** Set (or clear, with --off) the skill / slash-command backing this session. */
export function skill(sessionArg: string | undefined, name: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!name || !name.trim())) {
    console.error("usage: ccs skill [<session-id>|.] <name> | --off");
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    // Normalise a leading slash so `/event-watch` and `event-watch` land on the same value.
    const value = off ? null : name!.trim().replace(/^\//, "");
    setSkill(db, id, value, now());
    console.log(off ? `cleared skill on ${id.slice(0, 8)}…` : `skill ${value} → ${id.slice(0, 8)}…`);
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
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    setProject(db, id, off ? null : label!.trim(), now());
    console.log(off ? `cleared project on ${id.slice(0, 8)}…` : `project ${label!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** Set (or clear, with --off) the system grouping for this session. */
export function system(sessionArg: string | undefined, slug: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!slug || !slug.trim())) {
    console.error('usage: ccs system [<session-id>|.] <slug> [--off]');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    setSystem(db, id, off ? null : slug!.trim(), now());
    console.log(off ? `cleared system on ${id.slice(0, 8)}…` : `system ${slug!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** Token/cost detail from the Index for one session, or null when unindexed. */
function usageFor(id: string): { usage: SessionUsage; subagentUSD: number } | null {
  if (!existsSync(DB_PATH)) return null;
  const db = openIndex(DB_PATH);
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
  const db = openCatalogue(CATALOGUE_PATH);
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
    if (row?.skill) console.log(`  skill: ${row.skill}`);
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
