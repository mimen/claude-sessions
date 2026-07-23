import type { Database } from "bun:sqlite";
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";
import { getAll, lifecycleOf, type Lifecycle } from "../catalogue/db.ts";
import { listByRecency, search, type SessionRow } from "../index/index.ts";

const AUTO_MATCHED_LIMIT = 12;
const AUTO_RECENT_LIMIT = 8;
const AUTO_TOTAL_LIMIT = 20;
const MANUAL_MATCHED_LIMIT = 6;
const MANUAL_RECENT_LIMIT = 4;
const MANUAL_TOTAL_LIMIT = 8;
const PROJECT_LIMIT = 24;

export interface StartSessionCandidate {
  readonly id: string;
  readonly title: string;
  readonly projectName: string;
  readonly cwd: string;
  readonly lastActiveAt: string | null;
  readonly lifecycle: Exclude<Lifecycle, "archived">;
}

export interface StartProjectCandidate {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: "current" | "index";
  readonly lastActiveAt: string | null;
}

export interface StartCandidates {
  readonly autoResumeSessions: readonly StartSessionCandidate[];
  readonly manualOnlySessions: readonly StartSessionCandidate[];
  readonly projects: readonly StartProjectCandidate[];
}

interface ProjectAggregate {
  readonly path: string;
  name: string;
  source: "current" | "index";
  lastActiveAt: string | null;
  relevance: number;
}

/** Build the bounded, verified candidate set the routing model may choose from. */
export function buildStartCandidates(
  indexDb: Database,
  catalogueDb: Database,
  description: string,
  currentCwd: string,
): StartCandidates {
  const rows = listByRecency(indexDb, false);
  const matchedIds = new Set(search(indexDb, description, false).map((row) => row.sessionId));
  const catalogue = getAll(catalogueDb);

  const workBodies = rows.filter((row) => {
    const metadata = catalogue.get(row.sessionId);
    return metadata?.sessionClass === "work_body"
      && metadata.kind !== "loop"
      && lifecycleOf(metadata) !== "archived";
  });

  const activeRows = workBodies.filter((row) => lifecycleOf(catalogue.get(row.sessionId) ?? null) === "idle");
  const manualRows = workBodies.filter((row) => {
    const lifecycle = lifecycleOf(catalogue.get(row.sessionId) ?? null);
    return lifecycle === "parked" || lifecycle === "completed";
  });

  const autoRows = selectBoundedRows(
    activeRows,
    matchedIds,
    AUTO_MATCHED_LIMIT,
    AUTO_RECENT_LIMIT,
    AUTO_TOTAL_LIMIT,
  );
  const manualSelected = selectBoundedRows(
    manualRows,
    matchedIds,
    MANUAL_MATCHED_LIMIT,
    MANUAL_RECENT_LIMIT,
    MANUAL_TOTAL_LIMIT,
  );

  return {
    autoResumeSessions: autoRows.map((row) => sessionCandidate(
      row,
      lifecycleOf(catalogue.get(row.sessionId) ?? null),
    )),
    manualOnlySessions: manualSelected.map((row) => sessionCandidate(
      row,
      lifecycleOf(catalogue.get(row.sessionId) ?? null),
    )),
    projects: projectCandidates(rows, matchedIds, description, currentCwd),
  };
}

function selectBoundedRows(
  rows: readonly SessionRow[],
  matchedIds: ReadonlySet<string>,
  matchedLimit: number,
  recentLimit: number,
  totalLimit: number,
): SessionRow[] {
  const selected: SessionRow[] = [];
  const seen = new Set<string>();
  const append = (row: SessionRow): void => {
    if (seen.has(row.sessionId) || selected.length >= totalLimit) return;
    seen.add(row.sessionId);
    selected.push(row);
  };

  for (const row of rows.filter((candidate) => matchedIds.has(candidate.sessionId)).slice(0, matchedLimit)) {
    append(row);
  }
  for (const row of rows.slice(0, recentLimit)) append(row);
  return selected;
}

function sessionCandidate(
  row: SessionRow,
  lifecycle: Lifecycle,
): StartSessionCandidate {
  return {
    id: row.sessionId,
    title: row.title,
    projectName: row.projectName,
    cwd: row.cwd ?? row.projectRoot,
    lastActiveAt: row.lastTs,
    lifecycle: lifecycle === "archived" ? "idle" : lifecycle,
  };
}

function projectCandidates(
  rows: readonly SessionRow[],
  matchedIds: ReadonlySet<string>,
  description: string,
  currentCwd: string,
): StartProjectCandidate[] {
  const projects = new Map<string, ProjectAggregate>();
  const current = verifiedDirectory(currentCwd);
  if (current) {
    projects.set(current, {
      path: current,
      name: basename(current) || current,
      source: "current",
      lastActiveAt: null,
      relevance: Number.POSITIVE_INFINITY,
    });
  }

  for (const row of rows) {
    const path = verifiedDirectory(row.projectRoot);
    if (!path) continue;
    const relevance = textOverlap(description, `${row.projectName} ${path} ${row.title}`)
      + (matchedIds.has(row.sessionId) ? 10 : 0);
    const existing = projects.get(path);
    if (!existing) {
      projects.set(path, {
        path,
        name: row.projectName || basename(path) || path,
        source: "index",
        lastActiveAt: row.lastTs,
        relevance,
      });
      continue;
    }
    if (existing.source !== "current") existing.relevance = Math.max(existing.relevance, relevance);
    if (isLater(row.lastTs, existing.lastActiveAt)) existing.lastActiveAt = row.lastTs;
  }

  return [...projects.values()]
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === "current" ? -1 : 1;
      if (left.relevance !== right.relevance) return right.relevance - left.relevance;
      return timestamp(right.lastActiveAt) - timestamp(left.lastActiveAt);
    })
    .slice(0, PROJECT_LIMIT)
    .map((project, index) => ({
      id: `project-${index + 1}`,
      name: project.name,
      path: project.path,
      source: project.source,
      lastActiveAt: project.lastActiveAt,
    }));
}

function verifiedDirectory(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function textOverlap(query: string, value: string): number {
  const queryTokens = new Set(tokens(query));
  if (queryTokens.size === 0) return 0;
  const valueTokens = new Set(tokens(value));
  let score = 0;
  for (const token of queryTokens) if (valueTokens.has(token)) score++;
  return score;
}

function tokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2);
}

function isLater(candidate: string | null, current: string | null): boolean {
  return timestamp(candidate) > timestamp(current);
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
