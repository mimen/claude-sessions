import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TASKS_PATH } from "../paths.ts";

/**
 * Read-only view over Claude Code's per-session task lists (the TaskCreate/TaskUpdate
 * tool state) at ~/.claude/tasks/<sessionId>/N.json. The dir name is the session's
 * filename UUID — verified to match every Store JSONL. Same mtime-cached sidecar
 * pattern as board/indexer.ts; this dir is Claude Code's private state, so any parse
 * failure degrades to "no tasks", never a throw into the render path.
 */

export type SessionTaskStatus = "pending" | "in_progress" | "completed";

export interface SessionTask {
  id: string;
  subject: string;
  description: string;
  /** Present-continuous spinner text — best one-liner for "what was it doing". */
  activeForm: string;
  status: SessionTaskStatus;
  blocks: string[];
  blockedBy: string[];
}

export interface TaskSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  /** First in_progress task in id order, for single-line display. */
  active: SessionTask | null;
  /** All tasks, sorted by numeric id (creation order — reads as the plan). */
  tasks: SessionTask[];
}

interface CacheEntry {
  summary: TaskSummary;
  mtime: number;
}

const cache = new Map<string, CacheEntry>();

function tasksRoot(): string {
  return process.env.CCS_TASKS_PATH ?? DEFAULT_TASKS_PATH;
}

const STATUSES: readonly SessionTaskStatus[] = ["pending", "in_progress", "completed"];

function parseTask(raw: string): SessionTask | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.subject !== "string") return null;
  const status = STATUSES.includes(rec.status as SessionTaskStatus)
    ? (rec.status as SessionTaskStatus)
    : "pending";
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    id: typeof rec.id === "string" ? rec.id : "",
    subject: rec.subject,
    description: typeof rec.description === "string" ? rec.description : "",
    activeForm: typeof rec.activeForm === "string" ? rec.activeForm : "",
    status,
    blocks: strings(rec.blocks),
    blockedBy: strings(rec.blockedBy),
  };
}

function summarize(tasks: SessionTask[]): TaskSummary {
  tasks.sort((a, b) => Number(a.id) - Number(b.id));
  const completed = tasks.filter((t) => t.status === "completed").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  return {
    total: tasks.length,
    completed,
    inProgress,
    pending: tasks.length - completed - inProgress,
    active: tasks.find((t) => t.status === "in_progress") ?? null,
    tasks,
  };
}

function load(sessionId: string): TaskSummary | null {
  const dir = join(tasksRoot(), sessionId);
  let mtime = 0;
  try {
    mtime = statSync(dir).mtimeMs;
  } catch {
    cache.delete(sessionId);
    return null;
  }
  const cached = cache.get(sessionId);
  if (cached && cached.mtime === mtime) return cached.summary;
  const tasks: SessionTask[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const task = parseTask(readFileSync(join(dir, name), "utf8"));
        if (task) tasks.push(task);
      } catch {
        // unreadable file mid-write — skip it, keep the rest
      }
    }
  } catch {
    return null;
  }
  if (tasks.length === 0) return null;
  const summary = summarize(tasks);
  cache.set(sessionId, { summary, mtime });
  return summary;
}

/** Task summary for a session, or null when it has no task list. Cached on dir mtime. */
export function tasksFor(sessionId: string): TaskSummary | null {
  return load(sessionId);
}

/** Session ids that currently have a task dir — for bulk decoration passes. */
export function sessionsWithTasks(): Set<string> {
  try {
    return new Set(
      readdirSync(tasksRoot(), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}
