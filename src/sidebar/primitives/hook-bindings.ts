/**
 * Primitive 2 — cmux's hook-store bindings.
 *
 * Answers: which session is bound to which surface, plus the store's own claims about
 * lifecycle, pid, and transcript path. Fail-closed: an unreadable store is empty and
 * `readable: false`. Revision advances only on a successful read whose identity payload
 * actually changed. Pid liveness and transcript presence are measured here so the join
 * (primitive 3) does not re-probe.
 */
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HookSessionEntry {
  readonly sessionId: string;
  readonly surfaceId: string | null;
  readonly agentLifecycle: string | null;
  readonly pid: number | null;
  readonly transcriptPath: string | null;
}

export type TranscriptPresence = "present" | "renamed" | "absent";

export interface HookBindingsIo {
  readStore(): Promise<string | null>;
  pidAlive(pid: number): Promise<boolean>;
  transcriptState(path: string | null, sessionId: string): TranscriptPresence;
}

export interface HookBindingsRead {
  readonly bindingsBySurface: ReadonlyMap<string, string>;
  readonly sessions: ReadonlyMap<string, HookSessionEntry>;
  readonly pidLiveness: ReadonlyMap<string, boolean>;
  readonly transcriptPresence: ReadonlyMap<string, TranscriptPresence>;
  readonly readable: boolean;
  readonly revision: number;
}

export function defaultHookStorePath(): string {
  return process.env.CMUX_HOOK_STORE_PATH ?? join(homedir(), ".cmuxterm", "claude-hook-sessions.json");
}

export function defaultClaudeStore(): string {
  return process.env.CLAUDE_STORE_PATH ?? join(homedir(), ".claude", "projects");
}

function defaultPidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 1) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "pid="], { encoding: "utf8", timeout: 3_000 }, (error, stdout) => {
      resolve(error === null && typeof stdout === "string" && stdout.trim().length > 0);
    });
  });
}

export function defaultTranscriptState(
  path: string | null,
  sessionId: string,
  storeRoot = defaultClaudeStore(),
): TranscriptPresence {
  if (path !== null && existsSync(path)) return "present";
  try {
    const glob = new Bun.Glob(`**/${sessionId}.orphaned-*.jsonl`);
    for (const _hit of glob.scanSync({ cwd: storeRoot, onlyFiles: true })) {
      void _hit;
      return "renamed";
    }
  } catch {
    // treated as absent
  }
  return "absent";
}

interface RawStore {
  sessions?: Record<string, {
    sessionId?: string | null;
    surfaceId?: string | null;
    agentLifecycle?: string | null;
    pid?: number | null;
    transcriptPath?: string | null;
  }>;
  activeSessionsBySurface?: Record<string, { sessionId?: string }>;
}

function identityOf(
  bindings: ReadonlyMap<string, string>,
  sessions: ReadonlyMap<string, HookSessionEntry>,
): string {
  const bind = [...bindings.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(",");
  const sess = [...sessions.values()]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((s) => `${s.sessionId}:${s.surfaceId ?? ""}:${s.agentLifecycle ?? ""}:${s.pid ?? ""}`)
    .join(";");
  return `${bind}|${sess}`;
}

export function parseHookStoreRaw(raw: string): {
  bindingsBySurface: Map<string, string>;
  sessions: Map<string, HookSessionEntry>;
} | null {
  let store: RawStore;
  try {
    store = JSON.parse(raw) as RawStore;
  } catch {
    return null;
  }
  const bindingsBySurface = new Map<string, string>();
  for (const [surfaceId, binding] of Object.entries(store.activeSessionsBySurface ?? {})) {
    const sessionId = binding?.sessionId;
    if (!sessionId) continue;
    bindingsBySurface.set(surfaceId, sessionId);
  }
  const sessions = new Map<string, HookSessionEntry>();
  for (const [key, entry] of Object.entries(store.sessions ?? {})) {
    const sessionId = entry?.sessionId ?? key;
    sessions.set(key, {
      sessionId,
      surfaceId: entry?.surfaceId ?? null,
      agentLifecycle: entry?.agentLifecycle ?? null,
      pid: typeof entry?.pid === "number" ? entry.pid : null,
      transcriptPath: entry?.transcriptPath ?? null,
    });
  }
  return { bindingsBySurface, sessions };
}

export function createHookBindingsReader(
  io?: Partial<HookBindingsIo>,
): { read(): Promise<HookBindingsRead> } {
  const storePath = defaultHookStorePath();
  const resolved: HookBindingsIo = {
    readStore: io?.readStore ?? (() => {
      try {
        return Promise.resolve(readFileSync(storePath, "utf8"));
      } catch {
        return Promise.resolve(null);
      }
    }),
    pidAlive: io?.pidAlive ?? defaultPidAlive,
    transcriptState: io?.transcriptState ?? ((path, sessionId) => defaultTranscriptState(path, sessionId)),
  };
  let revision = 0;
  let lastIdentity: string | null = null;
  return {
    async read(): Promise<HookBindingsRead> {
      const raw = await resolved.readStore();
      if (raw === null) {
        return {
          bindingsBySurface: new Map(),
          sessions: new Map(),
          pidLiveness: new Map(),
          transcriptPresence: new Map(),
          readable: false,
          revision,
        };
      }
      const parsed = parseHookStoreRaw(raw);
      if (parsed === null) {
        return {
          bindingsBySurface: new Map(),
          sessions: new Map(),
          pidLiveness: new Map(),
          transcriptPresence: new Map(),
          readable: false,
          revision,
        };
      }
      const pidLiveness = new Map<string, boolean>();
      const transcriptPresence = new Map<string, TranscriptPresence>();
      for (const entry of parsed.sessions.values()) {
        transcriptPresence.set(entry.sessionId, resolved.transcriptState(entry.transcriptPath, entry.sessionId));
        if (entry.agentLifecycle === "running" && entry.pid != null) {
          pidLiveness.set(entry.sessionId, await resolved.pidAlive(entry.pid));
        }
      }
      const identity = identityOf(parsed.bindingsBySurface, parsed.sessions);
      if (identity !== lastIdentity) {
        revision += 1;
        lastIdentity = identity;
      }
      return {
        bindingsBySurface: parsed.bindingsBySurface,
        sessions: parsed.sessions,
        pidLiveness,
        transcriptPresence,
        readable: true,
        revision,
      };
    },
  };
}
