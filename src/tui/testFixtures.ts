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
  project: null,
  role: null,
  substrate: null,
  identity: null,
  notes: null,
  updatedAt: null,
  ...over,
});

/** Minimal SessionRow stub — only the fields the grouping/classification code reads. */
export const row = (id: string, lastTs: string): SessionRow =>
  ({ sessionId: id, title: id, lastTs, isSubagent: false } as unknown as SessionRow);
