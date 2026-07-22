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
import { existsSync } from "node:fs";
import { openCatalogue, getRow } from "../catalogue/db.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import { renderStatusline, renderMeters } from "../catalogue/render-statusline.ts";
import { getGrouping } from "../state/groupings.ts";

interface StatuslinePayload {
  session_id?: string;
  cwd?: string;
  workspace?: { current_dir?: string; cwd?: string; project_dir?: string };
  // Live-session fields Claude Code pipes each turn — used for the meters line (line 2). All
  // optional/conditional (absent early in a session or for models without effort), handled leniently.
  model?: { id?: string; display_name?: string };
  cost?: { total_cost_usd?: number };
  context_window?: { used_percentage?: number | null; context_window_size?: number | null };
  effort?: { level?: string };
  fast_mode?: boolean;
}

/**
 * Count + summed cost of this session's subagent runs, from the search index.
 *
 * Id-set semantics are deliberately identical to `subagentCostOf` (index/index.ts): subagent rows
 * key their parent by the parent's INTERNAL sessionId, which differs from the id Claude Code hands
 * us for a resumed/forked session — so we match the resume_id as well. Kept here rather than
 * alongside `subagentCostOf` only because index.ts currently carries unrelated work-in-progress;
 * worth consolidating into a `subagentStatsOf` there once that lands.
 *
 * One indexed query (idx_sessions_parent), ~5ms — well inside the statusline's budget. Fail-open:
 * a missing/locked index yields zeros, which simply omits the bit.
 */
function subagentStats(sessionId: string): { n: number; usd: number } {
  const none = { n: 0, usd: 0 };
  try {
    if (!existsSync(DB_PATH())) return none;
    const db = openIndex(DB_PATH());
    try {
      const row = db
        .query(
          `SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM sessions
           WHERE is_subagent = 1 AND parent_session_id IN (
             SELECT resume_id FROM sessions WHERE session_id = $id
             UNION SELECT $id
           )`,
        )
        .get({ $id: sessionId }) as { n: number; usd: number } | null;
      return { n: row?.n ?? 0, usd: row?.usd ?? 0 };
    } finally {
      db.close();
    }
  } catch {
    return none;
  }
}

/** Parse the live payload into the meters line (line 2). Fail-open to "" so a malformed field can
 * never blank the whole statusline — the identity line still prints. */
function metersOf(p: StatuslinePayload, sub: { n: number; usd: number }): string {
  try {
    return renderMeters({
      subagentCount: sub.n,
      subagentUsd: sub.usd,
      modelId: p.model?.id ?? null,
      modelLabel: p.model?.display_name ?? null,
      effort: p.effort?.level ?? null,
      fast: p.fast_mode === true,
      ctxPercent: typeof p.context_window?.used_percentage === "number" ? p.context_window.used_percentage : null,
      ctxSize: typeof p.context_window?.context_window_size === "number" ? p.context_window.context_window_size : null,
      costUsd: typeof p.cost?.total_cost_usd === "number" ? p.cost.total_cost_usd : null,
    });
  } catch {
    return "";
  }
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
      ensureDataDir();
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
          // Review-app URL from the fleet identity's per-role attrs (post-ADR-0089). Read
          // via the identities module so we get the join automatically; fail-open on any
          // hiccup (loose sessions, missing table).
          let reviewAppUrl: string | null = null;
          if (row.identityKey) {
            try {
              const { getIdentity } = await import("../catalogue/identities.ts");
              const identity = getIdentity(db, row.identityKey);
              const url = identity?.attrs?.review_app_url;
              if (typeof url === "string" && url.startsWith("http")) reviewAppUrl = url;
            } catch {
              // no identity table / not fleet → no bit
            }
          }
          line = renderStatusline(row, { nowMs: Date.now(), grouping, statePill, reviewAppUrl });
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // fail-open: keep the default line
  }

  // Line 2: the live meters (model · effort · context · cost), from the payload — rendered for
  // EVERY session, not just tracked workers. Omitted entirely when nothing is known yet (empty
  // payload / pre-first-response), so an ordinary session degrades to just the identity line.
  const meters = metersOf(payload, payload.session_id ? subagentStats(payload.session_id) : { n: 0, usd: 0 });
  process.stdout.write((meters ? `${line}\n${meters}` : line) + "\n");
  return 0;
}
