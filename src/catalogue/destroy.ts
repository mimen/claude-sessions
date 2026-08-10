import { existsSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_STORE_PATH, DEFAULT_TASKS_PATH, runtimeRoot } from "../paths.ts";
import { sessionById } from "../index/index.ts";
import { getAll } from "./db-queries.ts";
import { clearEnrichment, deleteSessionRows, detachChildrenOf, setIncognito } from "./db-mutations.ts";
import { err, ok, type Result } from "../result.ts";

/**
 * `ccs session destroy` — the only operation in ccs that removes a session rather than flagging it.
 *
 * Everything else in this tool is additive or reversible: `archive` and `complete` set a bit and
 * explicitly leave the transcript alone. This deletes, and it cannot be undone, so the module is
 * built around one property: **a destroy either completes or changes nothing.** The manifest is
 * resolved and every live process is closed before a single file is unlinked, because the failure
 * this exists to prevent is a half-destroyed session that reads as gone but is not.
 *
 * What it deliberately does NOT touch:
 *
 *   - Identities. An identity outlives its sessions by design and is shared between them; deleting
 *     one because its last vessel died would remove a longer-lived thing than the caller named.
 *   - cmux's own logs, `~/.ccs/backups/*.db`, and system logs. Rewriting a live append-only file
 *     another process holds open risks corrupting it. These are reported instead, so the command's
 *     output is never read as a stronger guarantee than it can make.
 */

/** One session's full physical footprint, resolved before anything is deleted. */
export interface SessionFootprint {
  readonly sessionId: string;
  /** Canonical transcript, plus any duplicates the indexer found under other project slugs. */
  readonly transcripts: readonly string[];
  /** Directories removed whole: subagent sidechains, task state, edit history, session env. */
  readonly directories: readonly string[];
  /** Per-session sidecar files ccs itself writes. */
  readonly files: readonly string[];
  /** True when the session still has a live cmux embodiment. */
  readonly live: boolean;
  /** Present when the session belongs to an identity, which destroy will NOT remove. */
  readonly identityKey: string | null;
}

export interface DestroyManifest {
  /** The named session first, then every descendant, deepest last. */
  readonly footprints: readonly SessionFootprint[];
  /** Sessions that would be closed before deletion. */
  readonly liveSessionIds: readonly string[];
  /** Identities left behind, with the directories that keep holding their prose. */
  readonly survivingIdentities: readonly string[];
}

export interface DestroyOutcome {
  readonly destroyed: readonly string[];
  readonly filesRemoved: number;
  readonly rowsRemoved: Record<string, number>;
  readonly detachedChildren: number;
}

/** Injected so tests can drive the whole command without a real cmux or a real store. */
export interface DestroyEnvironment {
  readonly store: string;
  readonly tasks: string;
  readonly ccsRoot: string;
  readonly claudeHome: string;
  liveSessionIds(): Promise<ReadonlySet<string>>;
  closeSession(sessionId: string): Promise<boolean>;
}

export function productionEnvironment(): DestroyEnvironment {
  return {
    store: DEFAULT_STORE_PATH,
    tasks: DEFAULT_TASKS_PATH,
    ccsRoot: runtimeRoot(),
    claudeHome: join(process.env.HOME ?? homedir(), ".claude"),
    liveSessionIds: async () => {
      const { openSessionIds } = await import("../cmux/liveness.ts");
      return openSessionIds();
    },
    closeSession: async (sessionId) => {
      const { closeSessionWorkspace } = await import("../cmux/close-current.ts");
      const outcome = await closeSessionWorkspace(sessionId, true);
      return outcome.status === "closed";
    },
  };
}

/**
 * Every session in the causal subtree, parents before children.
 *
 * Walks `parent_session_id` breadth-first over the catalogue rather than recursing, so a cycle in
 * the data (which nothing prevents, since the column has no foreign key) terminates instead of
 * blowing the stack. The visited set is what makes that safe.
 */
export function resolveSubtree(catalogue: Database, rootSessionId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const [sessionId, row] of getAll(catalogue)) {
    if (!row.parentSessionId) continue;
    const siblings = childrenByParent.get(row.parentSessionId) ?? [];
    siblings.push(sessionId);
    childrenByParent.set(row.parentSessionId, siblings);
  }

  const ordered: string[] = [];
  const visited = new Set<string>();
  const queue = [rootSessionId];
  while (queue.length > 0) {
    const sessionId = queue.shift()!;
    if (visited.has(sessionId)) continue;
    visited.add(sessionId);
    ordered.push(sessionId);
    for (const child of childrenByParent.get(sessionId) ?? []) queue.push(child);
  }
  return ordered;
}

function existingPaths(candidates: readonly string[]): string[] {
  return candidates.filter((path) => existsSync(path));
}

/**
 * Resolve one session's footprint on disk.
 *
 * The index row is the only record of where a transcript actually lives, and a session that moved
 * worktrees has more than one file, so `shadowPaths` is read here rather than reconstructed from
 * the cwd. When the index has no row (never indexed, or already pruned) the transcript list is
 * empty and only the sidecars are collected. That is the honest answer: destroy cannot delete a
 * file it has no record of.
 */
export function footprintOf(
  sessionId: string,
  index: Database | null,
  catalogue: Database,
  env: DestroyEnvironment,
  live: ReadonlySet<string>,
): SessionFootprint {
  const indexed = index ? sessionById(index, sessionId) : null;
  const transcripts = existingPaths([
    ...(indexed ? [indexed.path] : []),
    ...(indexed?.shadowPaths ?? []),
  ]);

  // Subagent sidechains sit in a directory named for the parent session, alongside its transcript.
  const subagentDirs = transcripts
    .map((path) => join(dirname(path), sessionId))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory());

  const directories = existingPaths([
    ...subagentDirs,
    join(env.tasks, sessionId),
    join(env.claudeHome, "file-history", sessionId),
    join(env.claudeHome, "session-env", sessionId),
  ]);

  const files = existingPaths([
    join(env.ccsRoot, "enrich", `${sessionId}.log`),
    join(env.ccsRoot, "self-check", `${sessionId}.log`),
    join(env.ccsRoot, "self-check", `${sessionId}.last-prompt.md`),
    join(env.ccsRoot, "self-check", "locks", `${sessionId}.lock`),
  ]);

  const row = getAll(catalogue).get(sessionId);
  return {
    sessionId,
    transcripts,
    directories,
    files,
    live: live.has(sessionId),
    identityKey: row?.identityKey ?? null,
  };
}

export async function buildManifest(
  catalogue: Database,
  index: Database | null,
  rootSessionId: string,
  env: DestroyEnvironment,
): Promise<DestroyManifest> {
  const live = await env.liveSessionIds();
  const footprints = resolveSubtree(catalogue, rootSessionId).map((sessionId) =>
    footprintOf(sessionId, index, catalogue, env, live),
  );
  return {
    footprints,
    liveSessionIds: footprints.filter((f) => f.live).map((f) => f.sessionId),
    survivingIdentities: [
      ...new Set(footprints.map((f) => f.identityKey).filter((key): key is string => key !== null)),
    ],
  };
}

/**
 * Execute a resolved manifest.
 *
 * Ordering is the contract. Every live workspace is closed FIRST and a single failure aborts before
 * anything is deleted, because a running `claude` owns its transcript and re-flushes it each turn:
 * unlinking underneath a live process produces a resurrected file and a destroy that quietly did
 * not happen. Rows go last so that if the process dies mid-run, the catalogue still points at the
 * wreckage rather than forgetting it existed.
 */
export async function executeDestroy(
  catalogue: Database,
  index: Database | null,
  manifest: DestroyManifest,
  env: DestroyEnvironment,
  now: string,
): Promise<Result<DestroyOutcome, Error>> {
  for (const sessionId of manifest.liveSessionIds) {
    if (!(await env.closeSession(sessionId))) {
      return err(new Error(
        `refusing to destroy: could not close the live workspace for ${sessionId}. ` +
        "Nothing was deleted.",
      ));
    }
  }

  let filesRemoved = 0;
  for (const footprint of manifest.footprints) {
    for (const path of [...footprint.transcripts, ...footprint.files]) {
      rmSync(path, { force: true });
      filesRemoved++;
    }
    for (const dir of footprint.directories) {
      rmSync(dir, { recursive: true, force: true });
      filesRemoved++;
    }
  }

  const rowsRemoved: Record<string, number> = {};
  let detachedChildren = 0;
  catalogue.exec("BEGIN IMMEDIATE;");
  try {
    for (const footprint of manifest.footprints) {
      detachedChildren += detachChildrenOf(catalogue, footprint.sessionId, now);
      for (const [table, count] of Object.entries(deleteSessionRows(catalogue, footprint.sessionId))) {
        rowsRemoved[table] = (rowsRemoved[table] ?? 0) + count;
      }
    }
    catalogue.exec("COMMIT;");
  } catch (cause) {
    catalogue.exec("ROLLBACK;");
    return err(cause instanceof Error ? cause : new Error(String(cause)));
  }

  // Index rows are a pure cache and self-heal on the next reindex, but the FTS entry is only
  // cleaned in that same loop — so a session destroyed between reindexes would still answer a
  // search until then. Clear both now.
  if (index) {
    for (const footprint of manifest.footprints) {
      index.query("DELETE FROM sessions_fts WHERE session_id = $id").run({ $id: footprint.sessionId });
      index.query("DELETE FROM sessions WHERE session_id = $id").run({ $id: footprint.sessionId });
      index.query("DELETE FROM catalogue_hidden_sessions WHERE session_id = $id")
        .run({ $id: footprint.sessionId });
    }
  }

  return ok({
    destroyed: manifest.footprints.map((f) => f.sessionId),
    filesRemoved,
    rowsRemoved,
    detachedChildren,
  });
}

/**
 * Surfaces destroy does not own, named so its report is never read as more than it is.
 *
 * cmux holds its logs open and append-only; rewriting one to scrub lines risks corrupting another
 * tool's live state. The ccs backups exist precisely to survive mistakes like a mis-aimed destroy,
 * so removing them would defeat their purpose for every OTHER session.
 */
export function survivingSurfaces(env: DestroyEnvironment): string[] {
  const home = dirname(env.claudeHome);
  return [
    join(home, ".cmuxterm", "workstream.jsonl"),
    join(home, ".cmuxterm", "events.jsonl"),
    join(env.ccsRoot, "backups"),
    join(env.ccsRoot, "crash.log"),
  ];
}

/** Mark a session incognito, and remove anything a model already wrote about it. */
export function markIncognito(
  catalogue: Database,
  sessionId: string,
  incognito: boolean,
  now: string,
): void {
  setIncognito(catalogue, sessionId, incognito, now);
  // Marking mid-session is inherently late: the enrichment sweep may already have summarized this
  // transcript and stored the result. Clearing it undoes the local half of that. What already left
  // for the gateway cannot be recalled, which is why `--incognito` at birth is the airtight path.
  if (incognito) clearEnrichment(catalogue, sessionId, now);
}
