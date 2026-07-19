import type { SessionRow } from "../index/index.ts";
import type { CatalogueRow } from "../catalogue/db.ts";

/**
 * Shared TUI test fixtures. `cat()` is the ONE CatalogueRow factory — when a catalogue
 * migration adds columns, this is the only place tests need the new defaults.
 */
export const cat = (over: Partial<CatalogueRow> = {}): CatalogueRow => ({
  sessionId: "s",
  resumeId: null,
  customTitle: null,
  kind: "session",
  completed: false,
  archived: false,
  parkedTaskId: null,
  event: null,
  parentSessionId: null,
  skill: null,
  key: null,
  project: null,
  role: null,
  resumeCommand: null,
  substrate: null,
  identity: null,
  cluster: null,
  gusWork: null,
  workUnitId: null,
  groupingId: null,
  stage: null,
  statusLine: null,
  meta: {},
  notes: null,
  updatedAt: null,
  prNumber: null,
  prRepo: null,
  prBranch: null,
  prState: null,
  prHeadSha: null,
  ...over,
});

/** Minimal SessionRow stub — only the fields the grouping/classification code reads. */
export const row = (id: string, lastTs: string): SessionRow =>
  ({ sessionId: id, title: id, lastTs, isSubagent: false } as unknown as SessionRow);
