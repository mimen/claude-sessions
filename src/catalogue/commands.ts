import { ensureDataDir, CATALOGUE_PATH } from "../paths.ts";
import {
  openCatalogue,
  setCustomTitle,
  setKind,
  setCompleted,
  setArchived,
  setEvent,
  addTag,
  removeTag,
  getRow,
  getTags,
  type Kind,
} from "./db.ts";
import { pushCmuxRename } from "./open-state.ts";

/**
 * CLI surface for the catalogue. These are the primitives the in-session slash commands
 * (/session-rename, /session-loop, /session-tag, …) shell out to, and what `ccs` exposes
 * directly. Keep them dumb and composable.
 */

const now = (): string => new Date().toISOString();

/** Resolve the target session id: explicit arg, or "." / "self" / omitted → current session. */
function resolveSessionId(arg: string | undefined): string | null {
  if (!arg || arg === "." || arg === "self") return process.env.CLAUDE_CODE_SESSION_ID ?? null;
  return arg;
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

/** Set (or clear, with --off) the event slug a session belongs to. */
export function event(sessionArg: string | undefined, slug: string | undefined, flags: string[]): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const off = flags.includes("--off");
  if (!off && (!slug || !slug.trim())) {
    console.error('usage: ccs event [<session-id>|.] <slug> [--off]');
    return 1;
  }
  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    setEvent(db, id, off ? null : slug!.trim(), now());
    console.log(off ? `cleared event on ${id.slice(0, 8)}…` : `event ${slug!.trim()} → ${id.slice(0, 8)}…`);
  } finally {
    db.close();
  }
  return 0;
}

/** Print the current session's catalogue row (self-awareness). */
export function meta(sessionArg: string | undefined): number {
  const id = resolveSessionId(sessionArg);
  if (!id) return notInSession();
  const db = openCatalogue(CATALOGUE_PATH);
  try {
    const row = getRow(db, id);
    const tags = getTags(db, id);
    if (!row && tags.length === 0) {
      console.log(`${id}\n  (no catalogue metadata yet)`);
      return 0;
    }
    console.log(id);
    if (row?.customTitle) console.log(`  title: ${row.customTitle}`);
    console.log(`  kind: ${row?.kind ?? "session"}`);
    console.log(
      `  lifecycle: ${row?.archived ? "archived" : row?.completed ? "completed" : row?.parkedTaskId ? "parked" : "idle"}`,
    );
    if (row?.event) console.log(`  event: ${row.event}`);
    if (tags.length) console.log(`  tags: ${tags.join(", ")}`);
  } finally {
    db.close();
  }
  return 0;
}

function notInSession(): number {
  console.error("No session id (pass one, or run inside a Claude session for `.`).");
  return 1;
}
