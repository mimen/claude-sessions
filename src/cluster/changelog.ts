import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ccsConfigRoot } from "../roles/role-files.ts";
import { ccsRuntimeRoot, type Responsibility } from "../inbox/identity-path.ts";
import { readIdentityDoc, mergeIdentityDoc } from "../state/cluster-state.ts";

/**
 * The cluster CHANGELOG (ADR-0058) — the agent-facing, prescriptive record of how a cluster's
 * running agents must change their behavior, keyed by cluster version. This is the PLATFORM
 * generalization of pr-watch's engine-side `seed/CHANGELOG.md` + `changelog.py`: the format is the
 * same (a `version:` header line + `## … (version N)` entries with an optional `requiresRestart:`
 * line), but the READER lives in the tool and the delta is surfaced by a deterministic `catch-up`
 * start action (start-actions.ts) rather than a skill instruction an agent can forget.
 *
 * Why a hook, not an instruction (the ADR's core point): "read the changelog each tick" is prose
 * the agent can skip; a start action GUARANTEES the delta is injected on the agent's next turn. ccs
 * makes noticing deterministic; the entry's prescriptive clarity makes acting reliable.
 *
 * File location: `clusters/<cluster>/CHANGELOG.md` (package-relative, alongside cluster.toml). A
 * cluster without one simply has no deltas to surface (the catch-up action no-ops).
 */

/** One CHANGELOG entry, as the tool parses it. `title` is the human/agent-facing heading line. */
export interface ChangelogEntry {
  version: number;
  title: string;
  /** True when the change moved the ENVIRONMENT out from under a session (cwd/layout move) so it
   * can't self-apply by re-reading — the cluster's orchestrator must restart the session. An
   * instruction change is never a restart; only an environment change is. (pr-watch semantics.) */
  requiresRestart: boolean;
  /** The entry's body text (everything under the heading up to the next entry), trimmed. */
  body: string;
}

/** The whole parsed CHANGELOG: the current cluster version + every entry, oldest-first. */
export interface Changelog {
  currentVersion: number;
  entries: ChangelogEntry[];
}

// "## <anything> (version N)" — the trailing "(version N)" is the machine-read key; the rest of
// the heading is the human title. Matches pr-watch's "## <date> — <title> (loopVersion N)" once
// the cluster renames loopVersion→version.
const ENTRY_RE = /^##\s+(.+?)\s*\(version\s+(\d+)\)\s*$/gim;

/**
 * Parse CHANGELOG text into a structured Changelog. Tolerant: no entries → version 0.
 *
 * The current version is the HIGHEST entry version, NOT a separate header line. This is
 * deliberate (the authoring-safety fix): a hand-maintained `version:` header can drift from the
 * entries — an author adds `## … (version 3)` but forgets to bump the header — and the delta math
 * would then silently skip the new entry, the exact lost-propagation failure ADR-0058 exists to
 * prevent. Deriving the version from the entries makes "add the next-numbered entry" the ONE and
 * only authoring action; there is nothing to keep in sync.
 */
export function parseChangelog(text: string): Changelog {
  const entries: ChangelogEntry[] = [];
  const matches = [...text.matchAll(ENTRY_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const title = (m[1] ?? "").trim();
    const version = parseInt(m[2] ?? "0", 10);
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length;
    const body = text.slice(start, end).trim();
    const requiresRestart = /requiresRestart:\s*true/i.test(body);
    entries.push({ version, title, requiresRestart, body });
  }
  entries.sort((a, b) => a.version - b.version);
  const currentVersion = entries.length > 0 ? entries[entries.length - 1]!.version : 0;
  return { currentVersion, entries };
}

/**
 * Validate a parsed changelog's version sequence — the mechanical backstop that makes authoring
 * unambiguous (surfaced by `ccs hooks lint`). Entry versions must be a strictly-increasing run of
 * positive integers 1,2,3,… with none duplicated, skipped, or ≤0. A gap or dup would make an
 * agent's stamp compare wrong (a skipped number is a version no one can ever "catch up past"; a
 * dup means two entries share a key), so we refuse it loudly rather than propagate it silently.
 * Returns a list of human-readable problems (empty = valid).
 */
export function validateChangelog(log: Changelog): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  let expected = 1;
  for (const e of log.entries) {
    if (e.version <= 0) { problems.push(`entry "${e.title}" has a non-positive version ${e.version}`); continue; }
    if (seen.has(e.version)) { problems.push(`duplicate version ${e.version} ("${e.title}")`); continue; }
    seen.add(e.version);
    if (e.version !== expected) {
      problems.push(`version ${e.version} ("${e.title}") is out of sequence — expected ${expected} (numbers must run 1,2,3,… with no gaps)`);
    }
    expected = Math.max(expected, e.version) + 1;
  }
  return problems;
}

/** Read a cluster's CHANGELOG.md. Returns null when the file is absent (nothing to catch up on). */
export function readClusterChangelog(cluster: string, configRoot = ccsConfigRoot()): Changelog | null {
  const path = join(configRoot, "clusters", cluster, "CHANGELOG.md");
  if (!existsSync(path)) return null;
  try {
    return parseChangelog(readFileSync(path, "utf8"));
  } catch {
    return null; // unreadable → treat as no changelog (the gate/version contract is the loud path)
  }
}

/** The catch-up delta: the entries strictly newer than `seenVersion`, oldest-first, + a restart flag. */
export interface ChangelogDelta {
  currentVersion: number;
  seenVersion: number;
  entries: ChangelogEntry[];
  anyRestart: boolean;
}

/** Compute what an identity at `seenVersion` has not yet seen. Empty `entries` ⇒ nothing to surface. */
export function changelogSince(log: Changelog, seenVersion: number): ChangelogDelta {
  const entries = log.entries.filter((e) => e.version > seenVersion);
  return {
    currentVersion: log.currentVersion,
    seenVersion,
    entries,
    anyRestart: entries.some((e) => e.requiresRestart),
  };
}

/** Render a delta as the additionalContext text a `catch-up` start action injects. */
export function renderDelta(cluster: string, delta: ChangelogDelta): string {
  const header =
    `The "${cluster}" cluster changed since you last ran (config v${delta.seenVersion} → v${delta.currentVersion}). ` +
    `${delta.entries.length} update(s) below — re-orient and adopt them before continuing` +
    (delta.anyRestart ? " (one or more may need a restart the orchestrator handles):" : ":");
  const body = delta.entries
    .map((e) => `— v${e.version}${e.requiresRestart ? " [requiresRestart]" : ""}: ${e.title}\n${e.body}`)
    .join("\n\n");
  return `${header}\n\n${body}`;
}

/** The identity state doc + field where each identity records the cluster version it last saw. */
export const CATCH_UP_DOC = "catch-up";
export const SEEN_FIELD = "last_seen_cluster_version";

/** The result of a catch-up: the rendered delta to surface (null when up-to-date / no changelog),
 * plus the machine-read facts a caller (e.g. control) may act on. */
export interface CatchUpResult {
  /** additionalContext text to surface, or null when there's nothing new. */
  context: string | null;
  /** The cluster's current changelog version (0 when no changelog). */
  currentVersion: number;
  /** The version this identity had seen before this call. */
  seenVersion: number;
  /** Whether any newly-surfaced entry is requiresRestart (control acts on this). */
  anyRestart: boolean;
}

/**
 * The shared catch-up core (ADR-0058), used by BOTH the `catch-up` start action (SessionStart) and
 * the `ccs catch-up` command (each tick, for long-lived loops that re-arm in the same session and
 * so never re-hit SessionStart). Reads the cluster CHANGELOG, computes the delta since this
 * identity's last-seen stamp, and — only when there's something new — advances the stamp AFTER the
 * caller can surface it. The stamp advance is the sole side effect; it's idempotent: a session that
 * dies before its next turn re-surfaces the same entries next call (same move-on-drain contract).
 *
 * `configRoot`/`runtimeRoot` are injectable for testing; production uses the ambient roots.
 */
export function catchUp(
  cluster: string,
  r: Responsibility,
  configRoot = ccsConfigRoot(),
  runtimeRoot = ccsRuntimeRoot(),
  nowIso: string = new Date().toISOString(),
): CatchUpResult {
  const empty: CatchUpResult = { context: null, currentVersion: 0, seenVersion: 0, anyRestart: false };
  const log = readClusterChangelog(cluster, configRoot);
  if (!log) return empty; // cluster ships no CHANGELOG
  // A fresh embodiment has no stamp → seen 0, so it sees the full window (ADR-0058: a just-spawned
  // worker is never behind).
  const doc = readIdentityDoc<{ [SEEN_FIELD]?: number }>(runtimeRoot, r, CATCH_UP_DOC);
  const seen = typeof doc?.data?.[SEEN_FIELD] === "number" ? doc!.data[SEEN_FIELD]! : 0;
  const delta = changelogSince(log, seen);
  if (delta.entries.length === 0) {
    return { context: null, currentVersion: log.currentVersion, seenVersion: seen, anyRestart: false };
  }
  const context = renderDelta(cluster, delta);
  // Advance the stamp ONLY after composing the surfaced context (single-writer = catch-up).
  mergeIdentityDoc(runtimeRoot, r, CATCH_UP_DOC, { [SEEN_FIELD]: delta.currentVersion }, { source: "catch-up", now: nowIso });
  return { context, currentVersion: delta.currentVersion, seenVersion: seen, anyRestart: delta.anyRestart };
}
