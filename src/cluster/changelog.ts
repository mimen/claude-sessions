import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ccsConfigRoot } from "../roles/role-files.ts";

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

const HEADER_RE = /(?:^|\n)version:\s*(\d+)/i;
// "## <anything> (version N)" — the trailing "(version N)" is the machine-read key; the rest of
// the heading is the human title. Matches pr-watch's "## <date> — <title> (loopVersion N)" once
// the cluster renames loopVersion→version.
const ENTRY_RE = /^##\s+(.+?)\s*\(version\s+(\d+)\)\s*$/gim;

/** Parse CHANGELOG text into a structured Changelog. Tolerant: no header → version 0, no entries → []. */
export function parseChangelog(text: string): Changelog {
  const headerMatch = text.match(HEADER_RE);
  const currentVersion = headerMatch && headerMatch[1] ? parseInt(headerMatch[1], 10) : 0;

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
  return { currentVersion, entries };
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
