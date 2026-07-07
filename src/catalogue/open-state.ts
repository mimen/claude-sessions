import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Which sessions are currently OPEN in cmux. Derived live (never stored — it'd rot).
 *
 * The join is by WORKSPACE TITLE, not tty: cmux's persisted `ttyName` is null for most panels
 * and stale for the rest (panes reattach to new ttys), so a tty bridge finds almost nothing.
 * But cmux's persisted JSON reliably maps each workspace's Claude `agent.sessionId` to that
 * workspace's title, and `cmux tree` lists the titles of the workspaces that are live right now
 * — and ccs keeps those titles in sync via rename-workspace. So: a session is open iff its
 * persisted workspace title matches a live workspace title.
 *
 * macOS-specific path; returns empty / null when cmux isn't running or anything is missing
 * (caller treats "unknown" as "not open" — safe for a snapshot indicator).
 */
const PERSISTED = join(
  homedir(),
  "Library",
  "Application Support",
  "cmux",
  "session-com.cmuxterm.app.json",
);

/** Normalize a workspace title for matching: drop cmux's leading status glyph and trailing [tag]. */
function normTitle(t: string | null | undefined): string {
  return (t ?? "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim()
    .toLowerCase();
}

/**
 * Clean a cmux title for DISPLAY: strip only cmux's transient leading status glyph (a run of
 * non-ASCII symbols like ✳/●/spinner + space) while preserving case and any `[tag]` suffix the
 * user set. ASCII-leading titles (e.g. `/loop`) are left untouched.
 */
function cleanCmuxTitle(t: string): string {
  return t.replace(/^[^\x00-\x7F]+\s*/, "").trim();
}

/** Persisted map: normalized workspace title -> the Claude sessionId running in it. */
function titleToSessionId(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const data = JSON.parse(readFileSync(PERSISTED, "utf8")) as {
      windows?: { tabManager?: { workspaces?: Record<string, any>[] } }[];
    };
    for (const win of data.windows ?? []) {
      for (const w of win.tabManager?.workspaces ?? []) {
        const sid = ((w.panels ?? []) as Record<string, any>[])
          .map((p) => p?.terminal?.agent?.sessionId)
          .find(Boolean) as string | undefined;
        const title = normTitle(w.customTitle || w.processTitle);
        if (sid && title) map.set(title, sid);
      }
    }
  } catch {
    // missing/unreadable -> empty
  }
  return map;
}

/** A live cmux workspace: its normalized title (for matching), display title, and ref. */
interface LiveWorkspace {
  norm: string;
  display: string;
  ref: string;
}

/**
 * Short TTL cache over the `cmux tree` probe. The TUI re-derives open-state on every refresh
 * tick (title backfill fires many in a row); each probe is a SYNCHRONOUS block on the render
 * thread, and against a wedged cmux socket every one runs to its timeout — serial multi-second
 * freezes that read as a dead TUI. One probe per TTL window bounds the worst case.
 */
const PROBE_TTL_MS = 5000;
let probeCache: { at: number; value: Map<string, LiveWorkspace> | null } | null = null;

/** Live cmux workspaces keyed by normalized title. Null when cmux isn't reachable. */
function liveWorkspaces(cmuxBin: string): Map<string, LiveWorkspace> | null {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  const value = liveWorkspacesUncached(cmuxBin);
  probeCache = { at: Date.now(), value };
  return value;
}

function liveWorkspacesUncached(cmuxBin: string): Map<string, LiveWorkspace> | null {
  let out: string;
  try {
    out = execFileSync(cmuxBin, ["tree", "--all", "--json"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // cmux not running / not reachable
  }
  return parseTree(out);
}

function parseTree(out: string): Map<string, LiveWorkspace> | null {
  try {
    const tree = JSON.parse(out) as { windows?: { workspaces?: { title?: string; ref?: string }[] }[] };
    const map = new Map<string, LiveWorkspace>();
    for (const win of tree.windows ?? []) {
      for (const w of win.workspaces ?? []) {
        const norm = normTitle(w.title);
        if (norm && w.ref) map.set(norm, { norm, display: cleanCmuxTitle(w.title ?? ""), ref: w.ref });
      }
    }
    return map;
  } catch {
    return null;
  }
}

/** Async probe for the TUI: same TTL cache, but never blocks the event loop (see target.ts). */
function liveWorkspacesAsync(cmuxBin: string): Promise<Map<string, LiveWorkspace> | null> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return Promise.resolve(probeCache.value);
  return new Promise((resolve) => {
    const done = (value: Map<string, LiveWorkspace> | null): void => {
      probeCache = { at: Date.now(), value };
      resolve(value);
    };
    try {
      execFile(cmuxBin, ["tree", "--all", "--json"], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        done(err ? null : parseTree(String(stdout)));
      });
    } catch {
      done(null);
    }
  });
}

/** Async variant of openSessionTitles for the TUI's effects. */
export async function openSessionTitlesAsync(cmuxBin = "cmux"): Promise<Map<string, string>> {
  const live = await liveWorkspacesAsync(cmuxBin);
  const out = new Map<string, string>();
  if (!live) return out;
  for (const [title, sid] of titleToSessionId()) {
    const ws = live.get(title);
    if (ws && ws.display) out.set(sid, ws.display);
  }
  return out;
}

/**
 * sessionId -> the live cmux workspace title it's running in. cmux is the source of truth for
 * an open session's name (it's what the user sees + manages), so callers use this to override
 * the resolved ccs Title while a session is open. Empty when cmux isn't reachable.
 */
export function openSessionTitles(cmuxBin = "cmux"): Map<string, string> {
  const live = liveWorkspaces(cmuxBin);
  const out = new Map<string, string>();
  if (!live) return out;
  for (const [title, sid] of titleToSessionId()) {
    const ws = live.get(title);
    if (ws && ws.display) out.set(sid, ws.display);
  }
  return out;
}

export function openSessionIds(cmuxBin = "cmux"): Set<string> {
  return new Set(openSessionTitles(cmuxBin).keys());
}

/**
 * Resolve a session's live cmux workspace ref (for `rename-workspace` push): sessionId → its
 * persisted workspace title → the live workspace with that title. Null if not currently open.
 */
export function cmuxWorkspaceForSession(sessionId: string, cmuxBin = "cmux"): string | null {
  const live = liveWorkspaces(cmuxBin);
  if (!live) return null;
  for (const [title, sid] of titleToSessionId()) {
    if (sid === sessionId) return live.get(title)?.ref ?? null;
  }
  return null;
}

/** Push a workspace rename to cmux if the session is currently open there. Returns success. */
export function pushCmuxRename(sessionId: string, title: string, cmuxBin = "cmux"): boolean {
  const ref = cmuxWorkspaceForSession(sessionId, cmuxBin);
  if (!ref) return false;
  try {
    // rename-workspace takes the title positionally: `rename-workspace --workspace <ref> -- <title>`.
    // The `--` guards titles that start with a dash from being parsed as flags.
    execFileSync(cmuxBin, ["rename-workspace", "--workspace", ref, "--", title], {
      timeout: 4000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
