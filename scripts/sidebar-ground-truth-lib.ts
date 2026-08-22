/**
 * Live ground-truth oracles for the sidebar's state primitives.
 *
 * Read-only by construction: every oracle measures reality independently of ccs — a fresh
 * cmux tree, the hook store file itself, `ps` for claimed pids, Store transcripts on disk,
 * git in recorded directories — and diffs those facts against what the index and cmux's own
 * status output claim. Findings are raw evidence for phase 1; they classify nothing.
 */
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTree, type SurfaceLocation } from "../src/cmux/bridge.ts";
import { parseClaudeStatus, statusFromAgentLifecycle } from "../src/sidebar/status.ts";
import { readIndexReadOnly } from "../src/sidebar/index-read.ts";
import type { IndexedSessionInput } from "../src/sidebar/projection.ts";

export const CLAUDE_STORE =
  process.env.CLAUDE_STORE_PATH ?? join(homedir(), ".claude", "projects");
export const HOOK_STORE_PATH =
  process.env.CMUX_HOOK_STORE_PATH ??
  join(homedir(), ".cmuxterm", "claude-hook-sessions.json");
const CMUX_BIN = process.env.CMUX_BIN ?? "cmux";

/** Slack for clock skew: last_ts may trail mtime freely but may not exceed it by much. */
const MTIME_SLACK_MS = 5 * 60_000;
export const LINE_SAMPLE_COUNT = 40;
/** Above this size a transcript is skipped for line counting rather than read whole. */
const MAX_LINE_SAMPLE_BYTES = 20 * 1024 * 1024;
export const RECENT_WINDOW_MS = 24 * 60 * 60_000;
/** Files newer than this may simply be awaiting the next reindex pass. */
export const REINDEX_GRACE_MS = 10 * 60_000;

export interface Finding {
  readonly primitive: string;
  readonly severity: "error" | "warn" | "info";
  readonly detail: string;
  /**
   * Stable identity for live tracking: the same flaw observed on consecutive sweeps must map
   * to the same key so a watcher can distinguish persistent drift from a one-sweep race.
   */
  readonly key?: string;
}

export async function run(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
      resolve(error === null && typeof stdout === "string" ? stdout : null);
    });
  });
}

function statOf(path: string | null | undefined): { size: number; mtimeMs: number } | null {
  if (!path) return null;
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function findTranscript(sessionId: string): string | null {
  try {
    const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
    for (const hit of glob.scanSync({ cwd: CLAUDE_STORE, onlyFiles: true })) {
      return join(CLAUDE_STORE, hit);
    }
  } catch {
    // fall through to absent
  }
  return null;
}

/**
 * Claude Code renames transcripts to `<sessionId>.orphaned-<ts>-<hex>.jsonl` under conditions
 * we do not own; that is a moved file, not missing evidence, so callers treat it distinctly.
 */
export function transcriptState(path: string | null, sessionId: string): "present" | "renamed" | "absent" {
  if (path !== null && existsSync(path)) return "present";
  try {
    const glob = new Bun.Glob(`**/${sessionId}.orphaned-*.jsonl`);
    for (const _hit of glob.scanSync({ cwd: CLAUDE_STORE, onlyFiles: true })) {
      void _hit;
      return "renamed";
    }
  } catch {
    // treated as absent
  }
  return "absent";
}

async function pidAlive(pid: number | null): Promise<boolean> {
  if (pid === null || !Number.isInteger(pid) || pid <= 1) return false;
  const out = await run("/bin/ps", ["-p", String(pid), "-o", "pid="], 3_000);
  return out !== null && out.trim().length > 0;
}

function lineCountOf(path: string): number | null {
  try {
    if (statSync(path).size > MAX_LINE_SAMPLE_BYTES) return null;
    const lines = readFileSync(path, "utf8").split("\n");
    return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  } catch {
    return null;
  }
}

// --- primitive 1: surface tree ----------------------------------------------------

export interface TreeFacts {
  surfaces: SurfaceLocation[];
  workspaceIds: Set<string>;
}

export async function auditSurfaceTree(): Promise<{ facts: TreeFacts; findings: Finding[] }> {
  const findings: Finding[] = [];
  const raw = await run(CMUX_BIN, ["tree", "--all", "--json", "--id-format", "both"], 5_000);
  if (raw === null) {
    findings.push({
      primitive: "surface-tree",
      severity: "error",
      detail: "fresh `cmux tree --all --json` failed; downstream oracles are void this run",
    });
    return { facts: { surfaces: [], workspaceIds: new Set() }, findings };
  }
  let tree: unknown;
  try {
    tree = JSON.parse(raw);
  } catch {
    findings.push({
      primitive: "surface-tree",
      severity: "error",
      detail: "cmux tree emitted unparseable JSON",
    });
    return { facts: { surfaces: [], workspaceIds: new Set() }, findings };
  }
  const surfaces = parseTree(tree as Parameters<typeof parseTree>[0]);
  const seen = new Map<string, number>();
  const workspaceIds = new Set<string>();
  for (const s of surfaces) {
    seen.set(s.surfaceId, (seen.get(s.surfaceId) ?? 0) + 1);
    workspaceIds.add(s.workspaceId);
  }
  for (const [id, n] of seen) {
    if (n > 1) {
      findings.push({
        primitive: "surface-tree",
        severity: "warn",
        detail: `surface ${id} appears ${n}× in one fresh tree read`,
      });
    }
  }
  return { facts: { surfaces, workspaceIds }, findings };
}

// --- primitive 2+3: hook bindings & liveness ---------------------------------------

interface HookSessionEntry {
  sessionId?: string | null;
  surfaceId?: string | null;
  agentLifecycle?: string | null;
  pid?: number | null;
  transcriptPath?: string | null;
}

export interface HookFacts {
  bindingsBySurface: Map<string, string>;
  sessions: Map<string, HookSessionEntry>;
  /** Measured pid liveness per session id; only entries whose claim was checked appear. */
  pidLiveness: Map<string, boolean>;
  /** Measured transcript presence per session id (renamed = moved to .orphaned-*). */
  transcriptPresence: Map<string, "present" | "renamed" | "absent">;
}

export async function auditHookBindings(
  tree: TreeFacts,
): Promise<{ facts: HookFacts; findings: Finding[] }> {
  const findings: Finding[] = [];
  const facts: HookFacts = {
    bindingsBySurface: new Map(),
    sessions: new Map(),
    pidLiveness: new Map(),
    transcriptPresence: new Map(),
  };
  let store: {
    sessions?: Record<string, HookSessionEntry>;
    activeSessionsBySurface?: Record<string, { sessionId?: string }>;
  };
  try {
    store = JSON.parse(readFileSync(HOOK_STORE_PATH, "utf8"));
  } catch (error) {
    findings.push({
      primitive: "hook-bindings",
      severity: "error",
      detail: `hook store unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { facts, findings };
  }

  for (const [surfaceId, binding] of Object.entries(store.activeSessionsBySurface ?? {})) {
    const sessionId = binding?.sessionId;
    if (!sessionId) continue;
    facts.bindingsBySurface.set(surfaceId, sessionId);
    const surfaceExists =
      tree.workspaceIds.has(surfaceId) || tree.surfaces.some((s) => s.surfaceId === surfaceId);
    if (!surfaceExists) {
      findings.push({
        primitive: "hook-bindings",
        severity: "error",
        detail: `active binding ${surfaceId} -> ${sessionId} names a surface absent from the fresh tree (never pruned)`,
        key: `stale-binding:${surfaceId}`,
      });
    }
  }

  let renamed = 0;
  for (const [key, entry] of Object.entries(store.sessions ?? {})) {
    const sessionId = entry?.sessionId ?? key;
    facts.sessions.set(key, entry ?? {});
    const state = transcriptState(entry?.transcriptPath ?? null, sessionId);
    facts.transcriptPresence.set(sessionId, state);
    if (state === "renamed") renamed += 1;
    if (state === "absent") {
      findings.push({
        primitive: "hook-bindings",
        severity: "error",
        detail: `session ${sessionId} claims transcript ${entry?.transcriptPath ?? "(unrecorded path)"} which does not exist on disk`,
        key: `missing-transcript:${sessionId}`,
      });
    }
    if (entry?.agentLifecycle === "running") {
      const alive = await pidAlive(entry?.pid ?? null);
      facts.pidLiveness.set(sessionId, alive);
      if (!alive) {
        findings.push({
          primitive: "hook-bindings",
          severity: "error",
          detail: `session ${sessionId} claims agentLifecycle=running but pid ${entry?.pid} is not alive`,
          key: `ghost-running:${sessionId}`,
        });
      }
    }
  }
  if (renamed > 0) {
    findings.push({
      primitive: "hook-bindings",
      severity: "info",
      detail: `${renamed} hook-store sessions reference transcripts renamed to .orphaned-* (moved, not missing)`,
    });
  }
  return { facts, findings };
}

// --- primitive 4: agent activity differential --------------------------------------

export interface ActivityMeasurement {
  findings: Finding[];
  /** Authoritative pill label per workspace id, only where cmux published one. */
  pillsByWorkspace: Map<string, string>;
  agree: number;
  disagree: number;
}

export async function auditAgentActivity(
  tree: TreeFacts,
  hooks: HookFacts,
): Promise<ActivityMeasurement> {
  const findings: Finding[] = [];
  const pillsByWorkspace = new Map<string, string>();
  const lifecycleBySurface = new Map<string, string | null>();
  for (const [, session] of hooks.sessions) {
    if (session.surfaceId) lifecycleBySurface.set(session.surfaceId, session.agentLifecycle ?? null);
  }
  let agree = 0;
  let disagree = 0;
  let derivedUnknown = 0;

  for (const surface of tree.surfaces) {
    const output = await run(CMUX_BIN, ["list-status", "--workspace", surface.workspaceId], 4_000);
    if (output === null) continue;
    const status = parseClaudeStatus(output);
    if (status === null) continue;
    pillsByWorkspace.set(surface.workspaceId, status.label);
    const derived = statusFromAgentLifecycle(lifecycleBySurface.get(surface.surfaceId) ?? null);
    if (derived === null) {
      derivedUnknown += 1;
      continue;
    }
    if (derived.label === status.label) {
      agree += 1;
    } else {
      disagree += 1;
      findings.push({
        primitive: "agent-activity",
        severity: "warn",
        detail: `${surface.workspaceRef}: hook-store "${derived.label}" vs authoritative "${status.label}"`,
        key: `status-mismatch:${surface.workspaceId}`,
      });
    }
  }
  findings.push({
    primitive: "agent-activity",
    severity: "info",
    detail: `differential sample: ${agree} agree, ${disagree} disagree, ` +
      `${derivedUnknown} without derivable lifecycle (the known gap the authoritative sweep corrects)`,
  });
  return { findings, pillsByWorkspace, agree, disagree };
}

// --- primitives 6+5: transcript facts & coverage -----------------------------------

export function auditTranscriptRows(rows: readonly IndexedSessionInput[]): Finding[] {
  const findings: Finding[] = [];
  let bytesChecked = 0;
  let recencyChecked = 0;
  for (const row of rows) {
    const stat = statOf(row.transcriptPath);
    if (stat === null) continue;
    bytesChecked += 1;
    if (row.indexedBytes != null && row.indexedBytes > stat.size) {
      findings.push({
        primitive: "transcript-facts",
        severity: "error",
        detail: `${row.sessionId}: index claims ${row.indexedBytes}B but the file holds ${stat.size}B (index ahead of an append-only file)`,
        key: `index-bytes-ahead:${row.sessionId}`,
      });
    }
    recencyChecked += 1;
    if (row.lastTs !== null) {
      const ts = Date.parse(row.lastTs);
      if (Number.isFinite(ts) && ts > stat.mtimeMs + MTIME_SLACK_MS) {
        findings.push({
          primitive: "transcript-facts",
          severity: "error",
          detail: `${row.sessionId}: last_ts ${row.lastTs} exceeds the file's mtime beyond slack`,
          key: `ts-ahead:${row.sessionId}`,
        });
      }
    }
  }

  let counted = 0;
  for (const row of rows) {
    if (counted >= LINE_SAMPLE_COUNT) break;
    if (row.messageCount == null || row.transcriptPath == null) continue;
    const lines = lineCountOf(row.transcriptPath);
    if (lines === null) continue;
    counted += 1;
    const messageCount: number = row.messageCount;
    if (messageCount > lines + 2) {
      findings.push({
        primitive: "transcript-facts",
        severity: "error",
        detail: `${row.sessionId}: msg_count ${messageCount} exceeds the transcript's ${lines} lines`,
        key: `msgcount-ahead:${row.sessionId}`,
      });
    }
  }
  findings.push({
    primitive: "transcript-facts",
    severity: "info",
    detail: `checked ${bytesChecked} byte-sizes, ${recencyChecked} recencies, ${counted} line counts against the Store`,
  });
  return findings;
}

export interface CoverageInput {
  /** Every session id the store claims to know about. */
  readonly indexedIds: ReadonlySet<string>;
  /** session id -> absolute transcript path for recent files on disk. */
  readonly recentFiles: ReadonlyMap<string, { path: string; mtimeMs: number }>;
  readonly nowMs: number;
}

export function auditCoverage(input: CoverageInput): Finding[] {
  const findings: Finding[] = [];
  let missingFromIndex = 0;
  for (const [sessionId, file] of input.recentFiles) {
    if (!input.indexedIds.has(sessionId)) {
      missingFromIndex += 1;
      if (input.nowMs - file.mtimeMs > REINDEX_GRACE_MS) {
        findings.push({
          primitive: "coverage",
          severity: "error",
          detail: `transcript ${sessionId} absent from the index ${Math.round((input.nowMs - file.mtimeMs) / 60_000)}m after last write`,
          key: `coverage-missing:${sessionId}`,
        });
      }
    }
  }
  findings.push({
    primitive: "coverage",
    severity: "info",
    detail: `${missingFromIndex}/${input.recentFiles.size} recent store files not found in the index id set` +
      `(beyond the reindex grace these become per-session errors)`,
  });
  return findings;
}

// --- primitive 8: directory facts ---------------------------------------------------

export async function auditDirectories(rows: readonly IndexedSessionInput[]): Promise<Finding[]> {
  const findings: Finding[] = [];
  const cwds = [...new Set(rows.map((r) => r.cwd).filter((c): c is string => c !== null))].slice(0, 40);
  let missing = 0;
  for (const cwd of cwds) {
    if (existsSync(cwd)) continue;
    missing += 1;
    findings.push({
      primitive: "directory-facts",
      severity: "warn",
      detail: `cwd ${cwd} no longer exists on disk`,
      key: `cwd-missing:${cwd}`,
    });
  }
  findings.push({
    primitive: "directory-facts",
    severity: "info",
    detail: `checked existence of ${cwds.length} distinct cwd values (${missing} missing)`,
  });
  return findings;
}
