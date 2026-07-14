/**
 * `ccs statusline` — the Claude Code statusLine command (ADR-0027).
 *
 * Claude Code runs this each turn with the session context as JSON on stdin, and paints the
 * first stdout line as the status line at the bottom of the window. This is the ccs-owned
 * replacement for pr-watch's statusline.py + .pr-watch.json marker: it reads the ccs catalogue
 * live (one source, shared phase vocabulary with the tab + TUI) instead of a private file.
 *
 * Self-filtering: a session with no ccs row (or a row carrying no PR/work) prints a minimal,
 * unobtrusive default (the cwd basename) so ordinary sessions are unaffected. Fail-open
 * (ADR-0035): any error prints the safe default and exits 0 — the statusline never blocks a turn.
 */
import { basename } from "node:path";
import { openCatalogue, getRow } from "../catalogue/db.ts";
import { CATALOGUE_PATH } from "../paths.ts";
import { renderStatusline } from "../catalogue/render-statusline.ts";
import { getGrouping } from "../state/groupings.ts";

interface StatuslinePayload {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string; cwd?: string; project_dir?: string };
}

async function readStdin(): Promise<string> {
  try {
    return await new Response(Bun.stdin.stream()).text();
  } catch {
    return "";
  }
}

function payloadCwd(p: StatuslinePayload): string {
  if (p.cwd) return p.cwd;
  const ws = p.workspace ?? {};
  return ws.current_dir || ws.cwd || ws.project_dir || process.env.PWD || process.cwd();
}

/** The unobtrusive default for a non-worker session: just the directory name. */
function fallback(p: StatuslinePayload): string {
  return basename(payloadCwd(p)) || "~";
}

export async function statuslineCommand(): Promise<number> {
  let payload: StatuslinePayload = {};
  try {
    const raw = await readStdin();
    payload = raw.trim() ? (JSON.parse(raw) as StatuslinePayload) : {};
  } catch {
    payload = {};
  }

  let line = fallback(payload);
  try {
    if (payload.session_id) {
      const db = openCatalogue(CATALOGUE_PATH());
      try {
        const row = getRow(db, payload.session_id);
        // Only sessions with a PR or work-item get the rich statusline; others stay default.
        if (row && (row.prNumber || row.gusWork)) {
          // Grouping display (label+url) is cluster RUNTIME state now (ADR-0051), not a platform
          // epics table — the cluster's sensor filled it; we read the generic slot.
          const g = row.cluster && row.groupingId ? getGrouping(row.cluster, row.groupingId) : null;
          const grouping = g ? { label: g.shortName ?? g.label, url: g.url } : null;
          // State pill from board.json (ADR-0077): the composer emits label + color for this
          // session, matching the cmux tab exactly. One vocabulary + one color mapping across
          // cmux sidebar, ccs TUI, and this statusline — they can never disagree.
          let statePill: { label: string; color?: string } | null = null;
          if (row.cluster) {
            try {
              const { boardIndex } = await import("../board/indexer.ts");
              const hit = boardIndex(row.cluster).bySession(payload.session_id);
              const p = hit?.row.pills[0];
              if (p) statePill = { label: p.label, color: p.color };
            } catch {
              // no board → no pill; renderStatusline just omits the leading bit
            }
          }
          line = renderStatusline(row, { nowMs: Date.now(), grouping, statePill });
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // fail-open: keep the default line
  }

  process.stdout.write(line + "\n");
  return 0;
}
