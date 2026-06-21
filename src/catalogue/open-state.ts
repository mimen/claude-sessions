import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which sessions are currently OPEN in cmux. Derived live (never stored — it'd rot).
 *
 * cmux's live `tree` knows surfaces by tty but not by Claude session_id; cmux's persisted
 * session JSON maps `agent.sessionId -> ttyName`. Bridge them: a session is open iff its
 * tty (from the persisted JSON) is present as a live surface in `cmux tree`.
 *
 * macOS-specific path; returns an empty set when cmux isn't running or anything is missing
 * (caller treats "unknown" as "not open" — safe for a snapshot indicator).
 */
const PERSISTED = join(
  homedir(),
  "Library",
  "Application Support",
  "cmux",
  "session-com.cmuxterm.app.json",
);

function sessionIdToTty(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const data = JSON.parse(readFileSync(PERSISTED, "utf8")) as {
      windows?: { tabManager?: { workspaces?: { panels?: unknown[] }[] } }[];
    };
    for (const win of data.windows ?? []) {
      for (const w of win.tabManager?.workspaces ?? []) {
        for (const p of (w.panels ?? []) as Record<string, any>[]) {
          const sid = p?.terminal?.agent?.sessionId;
          const tty = p?.ttyName;
          if (sid && tty) map.set(sid, tty);
        }
      }
    }
  } catch {
    // missing/unreadable -> empty
  }
  return map;
}

function liveTtys(cmuxBin: string): Set<string> | null {
  let out: string;
  try {
    out = execFileSync(cmuxBin, ["tree", "--all", "--json"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // cmux not running / not reachable
  }
  const ttys = new Set<string>();
  try {
    const tree = JSON.parse(out) as { windows?: { workspaces?: { panes?: { surfaces?: { tty?: string }[] }[] }[] }[] };
    for (const win of tree.windows ?? []) {
      for (const w of win.workspaces ?? []) {
        for (const pane of w.panes ?? []) {
          for (const s of pane.surfaces ?? []) {
            if (s.tty) ttys.add(s.tty);
          }
        }
      }
    }
  } catch {
    return null;
  }
  return ttys;
}

export function openSessionIds(cmuxBin = "cmux"): Set<string> {
  const live = liveTtys(cmuxBin);
  if (!live) return new Set();
  const map = sessionIdToTty();
  const open = new Set<string>();
  for (const [sid, tty] of map) if (live.has(tty)) open.add(sid);
  return open;
}

/**
 * Resolve a session's live cmux workspace ref (for `rename-workspace` push), via
 * sessionId → tty (persisted JSON) → workspace ref (live tree). Null if not open.
 */
export function cmuxWorkspaceForSession(sessionId: string, cmuxBin = "cmux"): string | null {
  const tty = sessionIdToTty().get(sessionId);
  if (!tty) return null;
  let out: string;
  try {
    out = execFileSync(cmuxBin, ["tree", "--all", "--json"], {
      encoding: "utf8",
      timeout: 4000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  try {
    const tree = JSON.parse(out) as {
      windows?: { workspaces?: { ref?: string; panes?: { surfaces?: { tty?: string }[] }[] }[] }[];
    };
    for (const win of tree.windows ?? []) {
      for (const w of win.workspaces ?? []) {
        for (const pane of w.panes ?? []) {
          for (const s of pane.surfaces ?? []) {
            if (s.tty === tty && w.ref) return w.ref;
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Push a workspace rename to cmux if the session is currently open there. Returns success. */
export function pushCmuxRename(sessionId: string, title: string, cmuxBin = "cmux"): boolean {
  const ref = cmuxWorkspaceForSession(sessionId, cmuxBin);
  if (!ref) return false;
  try {
    execFileSync(cmuxBin, ["rename-workspace", "--workspace", ref, "--title", title], {
      timeout: 4000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
