import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openCatalogue } from "../../catalogue/db-schema.ts";
import { buildBridge, type Bridge, type CmuxHookStore, type CmuxTree } from "../../cmux/bridge.ts";
import { openIndex } from "../../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH } from "../../paths.ts";

export const FIXED_NOW = Date.parse("2026-08-05T12:00:00.000Z");
export const FLEET_SESSION_COUNT = 480;
export const LIVE_SESSION_COUNT = 24;

function stableId(prefix: string, index: number): string {
  return `${prefix}-${index.toString().padStart(4, "0")}`;
}

function timestampFor(index: number): string {
  return new Date(FIXED_NOW - index * 60_000).toISOString();
}

export interface SidebarFixture {
  readonly root: string;
  readonly cataloguePath: string;
  readonly indexPath: string;
  readonly bridge: Bridge;
  readonly liveSessionId: string;
}

export interface SidebarFixtureOptions {
  readonly sessionCount?: number;
  readonly liveSessionCount?: number;
}

export function createSidebarFixture(
  root: string,
  options: SidebarFixtureOptions = {},
): SidebarFixture {
  const sessionCount = options.sessionCount ?? FLEET_SESSION_COUNT;
  const liveSessionCount = options.liveSessionCount ?? LIVE_SESSION_COUNT;
  mkdirSync(join(root, "cache"), { recursive: true });
  const previousRoot = process.env.CCS_ROOT;
  process.env.CCS_ROOT = root;
  try {
    seedCatalogue(CATALOGUE_PATH(), sessionCount);
    seedIndex(DB_PATH(), root, sessionCount);
    const bridge = createFleetBridge(root, liveSessionCount);
    return {
      root,
      cataloguePath: CATALOGUE_PATH(),
      indexPath: DB_PATH(),
      bridge,
      liveSessionId: stableId("session", 0),
    };
  } finally {
    if (previousRoot === undefined) delete process.env.CCS_ROOT;
    else process.env.CCS_ROOT = previousRoot;
  }
}

function seedCatalogue(path: string, sessionCount: number): void {
  const db = openCatalogue(path, { materialize: false });
  try {
    const insert = db.query(
      `INSERT INTO catalogue
         (session_id, resume_id, custom_title, completed, archived, updated_at, session_class,
          enrichment_title, enrichment_state, enrichment_history, enrichment_next,
          enrichment_remaining, enrichment_recommendation, enrichment_reason, enrichment_junk,
          enrichment_cwd_correct, enrichment_at_messages, enrichment_at)
       VALUES
         ($sessionId, $resumeId, $title, $completed, $archived, $updatedAt, $sessionClass,
          $enrichmentTitle, $state, $history, $next, $remaining, $recommendation, $reason,
          0, 1, $atMessages, $enrichmentAt)`,
    );
    for (let index = 0; index < sessionCount; index += 1) {
      const lifecycle = index % 4;
      const enriched = index % 7 === 0;
      const recommendation = enriched ? (index % 14 === 0 ? "archive" : "complete") : null;
      insert.run({
        $sessionId: stableId("session", index),
        $resumeId: stableId("resume", index),
        $title: index % 9 === 0 ? `Catalogue title ${index}` : null,
        $completed: lifecycle === 2 ? 1 : 0,
        $archived: lifecycle === 3 ? 1 : 0,
        $updatedAt: timestampFor(index),
        $sessionClass: index % 11 === 0 ? "auxiliary" : "work_body",
        $enrichmentTitle: enriched ? `Enriched session ${index}` : null,
        $state: enriched ? `State ${index}` : null,
        $history: enriched ? `History ${index}` : null,
        $next: enriched ? `Next ${index}` : null,
        $remaining: enriched ? `Remaining ${index}` : null,
        $recommendation: recommendation,
        $reason: enriched ? `Reason ${index}` : null,
        $atMessages: enriched ? index : null,
        $enrichmentAt: enriched ? timestampFor(index + 1) : null,
      });
    }
  } finally {
    db.close();
  }
}

function seedIndex(path: string, root: string, sessionCount: number): void {
  const db = openIndex(path);
  try {
    const insert = db.query(
      `INSERT INTO sessions
         (session_id, host, path, cwd, project_root, project_name, branch, version,
          first_ts, last_ts, msg_count, file_mtime, file_size, native_title, fallback_label,
          is_subagent, resume_id, cost_usd, cost_by_model, models, last_model)
       VALUES
         ($sessionId, 'fixture-host', $path, $cwd, $cwd, $project, $branch, 'fixture',
          $firstTs, $lastTs, $messageCount, 0, 0, $title, $title, 0, $resumeId,
          $cost, $costByModel, $models, 'gpt-5.6-sol')`,
    );
    for (let index = 0; index < sessionCount; index += 1) {
      const cwd = join(root, "repos", `project-${index % 12}`);
      const title = `Indexed session ${index}`;
      insert.run({
        $sessionId: stableId("session", index),
        $path: join(root, "transcripts", `${stableId("session", index)}.jsonl`),
        $cwd: cwd,
        $project: `project-${index % 12}`,
        $branch: `fixture-${index % 6}`,
        $firstTs: timestampFor(index + 10),
        $lastTs: timestampFor(index),
        $messageCount: index + 3,
        $title: title,
        $resumeId: stableId("resume", index),
        $cost: index / 100,
        $costByModel: JSON.stringify({ "gpt-5.6-sol": index / 100 }),
        $models: JSON.stringify(["gpt-5.6-sol"]),
      });
    }
  } finally {
    db.close();
  }
}

function createFleetBridge(root: string, liveSessionCount: number): Bridge {
  const tree: CmuxTree = {
    active: { window_id: "window-0" },
    windows: [{
      id: "window-0",
      ref: "window:1",
      workspaces: Array.from({ length: liveSessionCount }, (_, index) => ({
        id: stableId("workspace", index),
        ref: `workspace:${index + 1}`,
        index,
        title: `Live session ${index}`,
        pinned: index % 8 === 0,
        active: index === 0,
        panes: [{
          id: stableId("pane", index),
          ref: `pane:${index + 1}`,
          index: 0,
          surfaces: [{
            id: stableId("surface", index),
            ref: `surface:${index + 1}`,
            type: "terminal",
            index_in_pane: 0,
          }],
        }],
      })),
    }],
  };
  const sessions: NonNullable<CmuxHookStore["sessions"]> = {};
  const activeSessionsBySurface: NonNullable<CmuxHookStore["activeSessionsBySurface"]> = {};
  for (let index = 0; index < liveSessionCount; index += 1) {
    const sessionId = stableId("session", index);
    const surfaceId = stableId("surface", index);
    sessions[sessionId] = {
      sessionId,
      surfaceId,
      workspaceId: stableId("workspace", index),
      cwd: join(root, "repos", `project-${index % 12}`),
      agentLifecycle: index % 3 === 0 ? "needsInput" : "running",
      isRestorable: true,
      updatedAt: Math.trunc((FIXED_NOW - index * 1_000) / 1_000),
    };
    activeSessionsBySurface[surfaceId] = { sessionId };
  }
  return buildBridge(tree, { sessions, activeSessionsBySurface });
}

export function inspectDatabase(path: string): {
  readonly userVersion: number;
  readonly journalMode: string;
  readonly catalogueRows: number | null;
  readonly indexRows: number | null;
} {
  const db = new Database(path, { readonly: true });
  try {
    const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    const journalMode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    const hasCatalogue = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalogue'",
    ).get() !== null;
    const hasIndex = db.query(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    ).get() !== null;
    return {
      userVersion,
      journalMode,
      catalogueRows: hasCatalogue
        ? (db.query("SELECT COUNT(*) AS count FROM catalogue").get() as { count: number }).count
        : null,
      indexRows: hasIndex
        ? (db.query("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count
        : null,
    };
  } finally {
    db.close();
  }
}
