/**
 * Live ground-truth comparator: a loopback web app that mirrors what ccs tracks next to
 * directly measured reality, refreshed forever.
 *
 * The unit of display is the SESSION ROW, not the discrepancy: each row shows what cmux's
 * hook store claims about a session beside fresh measurements (tree membership, ps on the
 * claimed pid, the filesystem, cmux's own status pill), with per-cell agreement. Rows whose
 * claims contradict measurements highlight and collect under Ghosts; everything else is a
 * mirror a human can spot-check against their own open tabs.
 *
 * Read-only against live state. bun run scripts/sidebar-ground-truth-live.ts [port]
 */
import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { CATALOGUE_PATH, DB_PATH } from "../src/paths.ts";
import { scanStore } from "../src/store.ts";
import { readIndexReadOnly } from "../src/sidebar/index-read.ts";
import { readCatalogueReadOnly } from "../src/sidebar/catalogue-read.ts";
import { readNotifications } from "../src/sidebar/notifications.ts";
import { readWorkspaceStates } from "../src/sidebar/workspace-state.ts";
import { createDirectoryFactsCache } from "../src/sidebar/directory-facts.ts";
import { subscribeToCmuxEvents, workspaceIdFromFrame } from "../src/cmux/events.ts";
import type { StoredEnrichment } from "../src/catalogue/enrichment.ts";
import {
  auditAgentActivity,
  auditCoverage,
  auditDirectories,
  auditHookBindings,
  auditSurfaceTree,
  auditTranscriptRows,
  CLAUDE_STORE,
  RECENT_WINDOW_MS,
  readWorkspacePill,
  type Finding,
} from "./sidebar-ground-truth-lib.ts";
import { statusFromAgentLifecycle } from "../src/sidebar/status.ts";
import { joinLiveness } from "../src/sidebar/primitives/liveness.ts";
import type { HookBindingsRead, HookSessionEntry } from "../src/sidebar/primitives/hook-bindings.ts";
import type { SurfaceTreeRead } from "../src/sidebar/primitives/surface-tree.ts";

const PORT = Number(process.argv[2] ?? 8793);
const ACTIVITY_EVERY_N_CYCLES = 5;

// --- condition ledger (secondary evidence; the mirror is the primary display) -------

interface Condition {
  key: string;
  primitive: string;
  severity: Finding["severity"];
  detail: string;
  firstSeen: number;
  lastSeen: number;
  sweeps: number;
  active: boolean;
}

interface ResolvedCondition extends Condition {
  resolvedAt: number;
}

const conditions = new Map<string, Condition>();
const recentlyResolved: ResolvedCondition[] = [];

function absorb(found: readonly Finding[]): void {
  const seen = new Set<string>();
  for (const f of found) {
    if (!f.key) continue;
    seen.add(f.key);
    const existing = conditions.get(f.key);
    if (existing?.active) {
      existing.lastSeen = Date.now();
      existing.sweeps += 1;
      existing.detail = f.detail;
    } else if (existing) {
      existing.active = true;
      existing.lastSeen = Date.now();
      existing.sweeps += 1;
      existing.detail = f.detail;
    } else {
      conditions.set(f.key, {
        key: f.key,
        primitive: f.primitive,
        severity: f.severity,
        detail: f.detail,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        sweeps: 1,
        active: true,
      });
    }
  }
  for (const c of conditions.values()) {
    if (c.active && !seen.has(c.key)) {
      c.active = false;
      recentlyResolved.unshift({ ...c, resolvedAt: Date.now() });
      if (recentlyResolved.length > 40) recentlyResolved.pop();
    }
  }
}

// --- the mirror ----------------------------------------------------------------------

export interface MirrorRow {
  kind: "claude" | "unbound";
  primary: boolean;
  sessionId: string;
  title: string | null;
  surfaceId: string | null;
  /** The tab's own name (the surface title cmux shows on the pane). */
  surfaceTitle: string | null;
  /** The workspace's name as cmux displays it on the tab bar. */
  workspaceTitle: string | null;
  workspaceRef: string | null;
  trackedLifecycle: string | null;
  surfaceInTree: boolean;
  /** cmux's own pointer: this surface's workspace is the one currently focused. */
  workspaceFocused: boolean;
  surfaceFocused: boolean;
  pidAlive: boolean | null;
  transcriptState: "present" | "renamed" | "absent";
  authoritativePill: string | null;
  derivedLabel: string | null;
  /** CCS catalogue: active / saved / completed / incognito. Null if unbound or unknown. */
  catalogueLifecycle: string | null;
  workspaceId: string | null;
  pinned: boolean;
  shortcut: number | null;
  unread: number;
  cwd: string | null;
  project: string | null;
  worktree: string | null;
  branch: string | null;
  lastActivityAt: number | null;
  messageCount: number | null;
  models: readonly string[];
  enrichmentState: string | null;
  enrichmentNext: string | null;
  enrichmentRecommendation: string | null;
}

export interface WorkspaceGroup {
  workspaceRef: string;
  workspaceTitle: string | null;
  workspaceFocused: boolean;
  pinned: boolean;
  shortcut: number | null;
  unread: number;
  tabs: MirrorRow[];
}

export interface WindowGroup {
  windowRef: string;
  windowFocused: boolean;
  workspaces: WorkspaceGroup[];
}

export interface Mirror {
  live: MirrorRow[];
  groups: WorkspaceGroup[];
  windows: WindowGroup[];
  ghosts: MirrorRow[];
  unboundSurfaces: Array<{ workspaceRef: string; title: string | null }>;
}

function toTreeRead(treeFacts: Awaited<ReturnType<typeof auditSurfaceTree>>["facts"]): SurfaceTreeRead {
  return {
    surfaces: treeFacts.surfaces,
    workspaceIds: treeFacts.workspaceIds,
    focusedWorkspaceId: treeFacts.surfaces.find((s) => s.workspaceActive)?.workspaceId ?? null,
    readable: true,
    revision: 0,
  };
}

function toBindingsRead(
  hooksFacts: Awaited<ReturnType<typeof auditHookBindings>>["facts"],
): HookBindingsRead {
  const sessions = new Map<string, HookSessionEntry>();
  for (const [key, entry] of hooksFacts.sessions) {
    const sessionId = entry.sessionId ?? key;
    sessions.set(key, {
      sessionId,
      surfaceId: entry.surfaceId ?? null,
      agentLifecycle: entry.agentLifecycle ?? null,
      pid: entry.pid ?? null,
      transcriptPath: entry.transcriptPath ?? null,
    });
  }
  return {
    bindingsBySurface: hooksFacts.bindingsBySurface,
    sessions,
    pidLiveness: hooksFacts.pidLiveness,
    transcriptPresence: hooksFacts.transcriptPresence,
    readable: true,
    revision: 0,
  };
}

function buildMirror(
  treeFacts: Awaited<ReturnType<typeof auditSurfaceTree>>["facts"],
  hooksFacts: Awaited<ReturnType<typeof auditHookBindings>>["facts"],
  pillsByWorkspace: Map<string, string>,
  titlesBySession: Map<string, string>,
): Mirror {
  const joined = joinLiveness(toTreeRead(treeFacts), toBindingsRead(hooksFacts));
  const decorate = (r: (typeof joined.live)[number], primary: boolean): MirrorRow => ({
    kind: "claude",
    primary,
    sessionId: r.sessionId,
    title: titlesBySession.get(r.sessionId) ?? null,
    surfaceId: r.surfaceId,
    surfaceTitle: r.surfaceTitle,
    workspaceTitle: r.workspaceTitle,
    workspaceRef: r.workspaceRef,
    trackedLifecycle: r.trackedLifecycle,
    surfaceInTree: r.surfaceInTree,
    workspaceFocused: r.workspaceFocused,
    surfaceFocused: r.surfaceFocused,
    pidAlive: r.pidAlive,
    transcriptState: r.transcriptState,
    authoritativePill: r.workspaceId
      ? pillsByWorkspace.get(r.workspaceId) ?? pillsByWorkspace.get(r.workspaceRef ?? "") ?? null
      : null,
    derivedLabel: statusFromAgentLifecycle(r.trackedLifecycle)?.label ?? null,
    catalogueLifecycle: catalogueLifecycleOf(r.sessionId),
    workspaceId: r.workspaceId,
    pinned: false,
    shortcut: null,
    ...extrasFor(r.sessionId, r.workspaceId),
  });
  const liveBySurface = new Map(
    joined.live.filter((r) => r.surfaceId).map((r) => [r.surfaceId as string, r]),
  );
  const byWindow: WindowGroup[] = [];
  const byWorkspace: WorkspaceGroup[] = [];
  const live: MirrorRow[] = [];
  for (const surface of treeFacts.surfaces) {
    let win = byWindow.find((w) => w.windowRef === surface.windowRef);
    if (!win) {
      win = {
        windowRef: surface.windowRef,
        windowFocused: surface.windowActive === true,
        workspaces: [],
      };
      byWindow.push(win);
    }
    const key = surface.workspaceRef;
    let group = win.workspaces.find((g) => g.workspaceRef === key);
    if (!group) {
      group = {
        workspaceRef: key,
        workspaceTitle: surface.workspaceTitle,
        workspaceFocused: surface.workspaceSelected === true,
        pinned: surface.workspacePinned === true,
        shortcut: shortcutForSurface(surface, treeFacts),
        unread: 0,
        tabs: [],
      };
      win.workspaces.push(group);
      byWorkspace.push(group);
    }
    const bound = liveBySurface.get(surface.surfaceId);
    const row: MirrorRow = bound
      ? decorate(bound, false)
      : {
          kind: "unbound",
          primary: false,
          sessionId: "",
          title: null,
          surfaceId: surface.surfaceId,
          surfaceTitle: surface.title,
          workspaceTitle: surface.workspaceTitle,
          workspaceRef: surface.workspaceRef,
          trackedLifecycle: null,
          surfaceInTree: true,
          workspaceFocused: surface.workspaceSelected === true,
          surfaceFocused: surface.workspaceSelected === true && surface.surfaceSelected === true,
          pidAlive: null,
          transcriptState: "present",
          authoritativePill: null,
          derivedLabel: null,
          catalogueLifecycle: null,
          workspaceId: surface.workspaceId,
          pinned: surface.workspacePinned === true,
          shortcut: shortcutForSurface(surface, treeFacts),
          ...extrasFor(null, surface.workspaceId),
        };
    if (bound) {
      row.pinned = surface.workspacePinned === true;
      row.shortcut = shortcutForSurface(surface, treeFacts);
    }
    group.tabs.push(row);
    live.push(row);
  }
  for (const group of byWorkspace) {
    const claudePrimary = group.tabs.find((t) => t.kind === "claude");
    if (claudePrimary) {
      for (const t of group.tabs) t.primary = t === claudePrimary;
    } else if (group.tabs[0]) {
      group.tabs[0].primary = true;
    }
    group.unread = group.tabs.reduce((n, t) => Math.max(n, t.unread), 0);
  }
  return {
    live,
    groups: byWorkspace,
    windows: byWindow,
    ghosts: joined.ghosts.map((r) => decorate(r, false)),
    unboundSurfaces: joined.unboundSurfaces.map((s) => ({
      workspaceRef: s.workspaceRef,
      title: s.workspaceTitle,
    })),
  };
}

// --- sweep loop -----------------------------------------------------------------------

let cycles = 0;
let lastSweepAt = 0;
let lastActivitySweepAt = 0;
let lastFullCycleAt = 0;
let sweeping = false;
let fullRunning = false;
let pillsByWorkspace = new Map<string, string>();
let latestMirror: Mirror = { live: [], groups: [], windows: [], ghosts: [], unboundSurfaces: [] };
let lastHooksFacts: Awaited<ReturnType<typeof auditHookBindings>>["facts"] | null = null;
let lastTitles = new Map<string, string>();
let lastTreeFacts: Awaited<ReturnType<typeof auditSurfaceTree>>["facts"] | null = null;
let catalogueBySession = new Map<string, string>();
let enrichmentBySession = new Map<string, StoredEnrichment>();
let indexFactsBySession = new Map<string, {
  lastActivityAt: number | null;
  messageCount: number | null;
  models: readonly string[];
  lastModel: string | null;
  cwd: string | null;
}>();
let unreadByWorkspaceId = new Map<string, number>();
let workspaceStateById = new Map<string, { cwd: string; branch: string | null }>();
const directoryFacts = createDirectoryFactsCache();
let directoryByCwd = new Map<string, { project: string | null; worktree: string | null; branch: string | null }>();
let catalogueKickPending = false;
let statusKickIds = new Set<string>();
let extrasKickPending = false;
let lastWorkingIds = new Set<string>();
let lastBilledKickIds = new Set<string>();
/** Session ids whose last billed model was peeked from the transcript after a stop. */
const peekedLastBilled = new Map<string, { model: string; at: number }>();
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function rowIsWorking(row: MirrorRow): boolean {
  const label = (row.authoritativePill ?? row.derivedLabel ?? row.trackedLifecycle ?? "").toLowerCase();
  return label === "running" || label === "working";
}

function peekLastAssistantModel(transcriptPath: string): string | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(transcriptPath).size;
    const window = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(window);
    readSync(fd, buf, 0, window, size - window);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    // First fragment is a truncated line when we did not start at byte 0.
    const start = size > window ? 1 : 0;
    for (let i = lines.length - 1; i >= start; i--) {
      const line = lines[i];
      if (!line || !line.includes("model")) continue;
      try {
        const parsed = JSON.parse(line) as {
          type?: string;
          message?: { model?: string };
          model?: string;
        };
        const model = parsed.message?.model ?? parsed.model ?? "";
        if (parsed.type === "assistant" && model && model !== "<synthetic>") return model;
      } catch {
        continue;
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function noteWorkingStops(): void {
  const nowWorking = new Set(
    latestMirror.live.filter((row) => row.sessionId && rowIsWorking(row)).map((row) => row.sessionId),
  );
  for (const id of lastWorkingIds) {
    if (!nowWorking.has(id)) lastBilledKickIds.add(id);
  }
  lastWorkingIds = nowWorking;
}

function refreshLastBilled(sessionId: string): void {
  const entry = lastHooksFacts?.sessions.get(sessionId);
  const path = entry?.transcriptPath;
  if (!path) return;
  const model = peekLastAssistantModel(path);
  if (!model) return;
  peekedLastBilled.set(sessionId, { model, at: Date.now() });
  const prev = indexFactsBySession.get(sessionId);
  indexFactsBySession.set(sessionId, {
    lastActivityAt: prev?.lastActivityAt ?? Date.now(),
    messageCount: prev?.messageCount ?? null,
    models: prev?.models ?? [model],
    lastModel: model,
    cwd: prev?.cwd ?? null,
  });
}

function catalogueLifecycleOf(sessionId: string): string | null {
  return catalogueBySession.get(sessionId) ?? null;
}

function shortcutForSurface(
  surface: { windowRef: string; workspaceIndex?: number | null },
  treeFacts: Awaited<ReturnType<typeof auditSurfaceTree>>["facts"],
): number | null {
  const focusedWindow = treeFacts.surfaces.find((s) => s.windowActive)?.windowRef ?? null;
  if (focusedWindow === null || surface.windowRef !== focusedWindow) return null;
  const index = surface.workspaceIndex;
  if (typeof index !== "number" || index < 0 || index > 8) return null;
  return index + 1;
}

function extrasFor(sessionId: string | null, workspaceId: string | null): Pick<
  MirrorRow,
  | "unread"
  | "cwd"
  | "project"
  | "worktree"
  | "branch"
  | "lastActivityAt"
  | "messageCount"
  | "models"
  | "enrichmentState"
  | "enrichmentNext"
  | "enrichmentRecommendation"
> {
  const index = sessionId ? indexFactsBySession.get(sessionId) : undefined;
  const ws = workspaceId ? workspaceStateById.get(workspaceId) : undefined;
  const cwd = ws?.cwd ?? index?.cwd ?? null;
  const dir = cwd ? directoryByCwd.get(cwd) : undefined;
  const enrichment = sessionId ? enrichmentBySession.get(sessionId) : undefined;
  return {
    unread: workspaceId ? unreadByWorkspaceId.get(workspaceId) ?? 0 : 0,
    cwd,
    project: dir?.project ?? null,
    worktree: dir?.worktree ?? null,
    branch: dir?.branch ?? ws?.branch ?? null,
    lastActivityAt: index?.lastActivityAt ?? null,
    messageCount: index?.messageCount ?? null,
    models: (() => {
      const peeked = sessionId ? peekedLastBilled.get(sessionId) : undefined;
      if (peeked) return [peeked.model];
      if (index?.lastModel) return [index.lastModel];
      return index?.models ?? [];
    })(),
    enrichmentState: enrichment?.state ?? null,
    enrichmentNext: enrichment?.next ?? null,
    enrichmentRecommendation: enrichment?.recommendation ?? null,
  };
}

function reloadCatalogue(): void {
  const outcome = readCatalogueReadOnly(CATALOGUE_PATH());
  if (outcome.status !== "ok") return;
  const next = new Map<string, string>();
  for (const [id, lifecycle] of outcome.facts.lifecycles) next.set(id, lifecycle);
  for (const id of outcome.facts.incognito) next.set(id, "incognito");
  catalogueBySession = next;
  enrichmentBySession = new Map(outcome.facts.summaries);
}

function paintMirrorFromCache(): void {
  if (lastTreeFacts === null || lastHooksFacts === null) return;
  latestMirror = buildMirror(lastTreeFacts, lastHooksFacts, pillsByWorkspace, lastTitles);
  noteWorkingStops();
  broadcastState();
}

function broadcastState(): void {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(statePayload())}\n\n`;
  const bytes = new TextEncoder().encode(payload);
  for (const c of [...sseClients]) {
    try {
      c.enqueue(bytes);
    } catch {
      sseClients.delete(c);
    }
  }
}

/**
 * The fast mirror path: only the tree is re-read, so a focus flip needs one ~35ms
 * subprocess instead of waiting behind the heavyweight pill sweep. Rows render with the
 * last full cycle's hook facts and pills; their pid/transcript cells follow on the next
 * full cycle. The focus highlight and row order are fresh, which is what the tail was about.
 */
async function fastMirrorCycle(): Promise<void> {
  const tree = await auditSurfaceTree();
  lastTreeFacts = tree.facts;
  if (lastHooksFacts !== null) {
    latestMirror = buildMirror(tree.facts, lastHooksFacts, pillsByWorkspace, lastTitles);
    noteWorkingStops();
  }
  if (lastEventAt > 0) lastEventMirrorMs = Date.now() - lastEventAt;
  cycles += 1;
  lastSweepAt = Date.now();
  broadcastState();
}

async function refreshWorkspacePills(workspaceKeys: Iterable<string>): Promise<void> {
  const keys = [...new Set(workspaceKeys)].filter((k) => k.length > 0);
  if (keys.length === 0) return;
  await Promise.all(
    keys.map(async (key) => {
      const label = await readWorkspacePill(key);
      if (label === null) return;
      pillsByWorkspace.set(key, label);
      const surface = lastTreeFacts?.surfaces.find(
        (s) => s.workspaceId === key || s.workspaceRef === key,
      );
      if (surface) {
        pillsByWorkspace.set(surface.workspaceId, label);
        pillsByWorkspace.set(surface.workspaceRef, label);
      }
    }),
  );
  lastActivitySweepAt = Date.now();
  paintMirrorFromCache();
}

async function timedCycle(includeActivity: boolean): Promise<void> {
  const nowMs = Date.now();
  const cycleFindings: Finding[] = [];

  const tree = await auditSurfaceTree();
  cycleFindings.push(...tree.findings);

  const hooks = await auditHookBindings(tree.facts);
  lastHooksFacts = hooks.facts;
  cycleFindings.push(...hooks.findings);

  // Pills survive between authoritative sweeps: an unswept workspace keeps its last
  // measurement rather than regressing to "not swept yet" every fast cycle.
  if (includeActivity) {
    const activity = await auditAgentActivity(tree.facts, hooks.facts);
    cycleFindings.push(...activity.findings);
    pillsByWorkspace = activity.pillsByWorkspace;
    lastActivitySweepAt = Date.now();
  }

  let indexRows: ReturnType<typeof readIndexReadOnly> = [];
  try {
    indexRows = readIndexReadOnly(DB_PATH(), { limit: 200 });
  } catch {
    // The transcript-facts checks simply skip this cycle when the index is unreadable.
  }
  cycleFindings.push(...auditTranscriptRows(indexRows));
  cycleFindings.push(...catalogueOrphanFindings());
  cycleFindings.push(...coverageFindings(indexRows, nowMs));
  cycleFindings.push(...(await auditDirectories(indexRows)));

  absorb(cycleFindings);
  cycles += 1;
  lastSweepAt = Date.now();
  lastFullCycleAt = Date.now();

  const titlesBySession = new Map<string, string>();
  for (const row of indexRows) {
    if (row.title) titlesBySession.set(row.sessionId, row.title);
  }
  lastTitles = titlesBySession;
  lastTreeFacts = tree.facts;
  reloadCatalogue();

  const nextIndex = new Map<string, {
    lastActivityAt: number | null;
    messageCount: number | null;
  models: readonly string[];
  lastModel: string | null;
    cwd: string | null;
  }>();
  for (const row of indexRows) {
    const peeked = peekedLastBilled.get(row.sessionId);
    const indexedLast = row.lastModel ?? null;
    const indexedAt = row.lastTs ? Date.parse(row.lastTs) : 0;
    const lastModel = peeked && peeked.at >= indexedAt ? peeked.model : indexedLast ?? peeked?.model ?? null;
    if (indexedLast && peeked && indexedAt > peeked.at) peekedLastBilled.delete(row.sessionId);
    const fact = {
      lastActivityAt: row.lastTs ? Date.parse(row.lastTs) : null,
      messageCount: row.messageCount ?? null,
      models: row.models,
      lastModel,
      cwd: row.cwd,
    };
    nextIndex.set(row.sessionId, fact);
    if (row.resumeId) nextIndex.set(row.resumeId, fact);
  }
  indexFactsBySession = nextIndex;

  const workspaceIds = [...new Set(tree.facts.surfaces.map((s) => s.workspaceId))];
  try {
    const notes = await readNotifications();
    unreadByWorkspaceId = new Map(notes.unreadCountsByWorkspaceId);
  } catch {
    // keep previous unread map
  }
  try {
    const states = await readWorkspaceStates(workspaceIds);
    const nextStates = new Map<string, { cwd: string; branch: string | null }>();
    const cwds: string[] = [];
    for (const [id, state] of states) {
      if (!state) continue;
      nextStates.set(id, { cwd: state.cwd, branch: state.branch });
      if (state.cwd) cwds.push(state.cwd);
    }
    workspaceStateById = nextStates;
    if (cwds.length > 0) {
      const dirs = await directoryFacts.lookup(cwds);
      const nextDir = new Map<string, { project: string | null; worktree: string | null; branch: string | null }>();
      for (const cwd of cwds) {
        const checkout = dirs.checkouts.get(cwd);
        nextDir.set(cwd, {
          project: checkout?.project ?? null,
          worktree: checkout?.worktree ?? null,
          branch: checkout?.branch ?? null,
        });
      }
      directoryByCwd = nextDir;
    }
  } catch {
    // extras stay at last known values
  }
  // Never paint from this cycle's tree: it may be seconds old by the time activity
  // and index work finish, and would clobber a rename/focus the fast path already showed.
  kickPending = true;
}

function coverageFindings(
  indexRows: ReturnType<typeof readIndexReadOnly>,
  nowMs: number,
): Finding[] {
  try {
    const scanned = scanStore(CLAUDE_STORE);
    if (!scanned.ok) return [];
    const ids = new Set(indexRows.map((r) => r.sessionId));
    try {
      const db = new Database(DB_PATH(), { readonly: true });
      const rows = db
        .query("SELECT session_id, resume_id FROM sessions")
        .all() as Array<{ session_id: string; resume_id: string | null }>;
      for (const r of rows) {
        ids.add(r.session_id);
        if (r.resume_id) ids.add(r.resume_id);
      }
      db.close();
    } catch {
      // fall back to the sampled id set
    }
    const recentFiles = new Map<string, { path: string; mtimeMs: number }>();
    for (const f of scanned.value) {
      if (nowMs - f.mtimeMs < RECENT_WINDOW_MS) {
        recentFiles.set(f.sessionId, { path: f.path, mtimeMs: f.mtimeMs });
      }
    }
    return auditCoverage({ indexedIds: ids, recentFiles, nowMs });
  } catch {
    return [];
  }
}

function catalogueOrphanFindings(): Finding[] {
  try {
    const db = new Database(CATALOGUE_PATH(), { readonly: true });
    const rows = db
      .query("SELECT session_id FROM catalogue")
      .all() as Array<{ session_id: string }>;
    db.close();
    const scanned = scanStore(CLAUDE_STORE);
    if (!scanned.ok) return [];
    const onDisk = new Set(scanned.value.map((f) => f.sessionId));
    const out: Finding[] = [];
    let orphans = 0;
    for (const r of rows) {
      if (!onDisk.has(r.session_id)) {
        orphans += 1;
        out.push({
          primitive: "catalogue-identity",
          severity: "warn",
          detail: `catalogue row ${r.session_id} has no transcript file on disk`,
          key: `catalogue-orphan:${r.session_id}`,
        });
      }
    }
    if (rows.length > 0 || orphans === 0) {
      out.push({
        primitive: "catalogue-identity",
        severity: "info",
        detail: `${orphans}/${rows.length} catalogue rows have no transcript on disk`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function sweepLoop(): Promise<void> {
  const FAST_CYCLE_MS = 1_500;
  while (true) {
    const now = Date.now();
    // Fast path: any liveness kick or a stale mirror triggers a cheap tree-only re-read.
    if (!sweeping && (kickPending || now - lastSweepAt >= FAST_CYCLE_MS)) {
      kickPending = false;
      sweeping = true;
      try {
        await fastMirrorCycle();
      } catch {
        // A failed fast cycle leaves the previous mirror standing; the next one retries.
      } finally {
        sweeping = false;
      }
    }
    // Full cycle on its own cadence, never overlapping the fast path.
    if (!fullRunning && now - lastFullCycleAt >= 3_000) {
      fullRunning = true;
      void timedCycle(cycles % ACTIVITY_EVERY_N_CYCLES === 0).finally(() => {
        fullRunning = false;
      });
    }
    if (statusKickIds.size > 0) {
      const ids = [...statusKickIds];
      statusKickIds.clear();
      void refreshWorkspacePills(ids);
    }
    if (catalogueKickPending) {
      catalogueKickPending = false;
      reloadCatalogue();
      paintMirrorFromCache();
    }
    if (lastBilledKickIds.size > 0) {
      const ids = [...lastBilledKickIds];
      lastBilledKickIds.clear();
      for (const id of ids) refreshLastBilled(id);
      paintMirrorFromCache();
      // Transcript flush can lag the pill drop; peek again shortly so we don't lock in the previous model.
      void (async () => {
        await Bun.sleep(400);
        for (const id of ids) refreshLastBilled(id);
        paintMirrorFromCache();
      })();
    }
    if (extrasKickPending && lastTreeFacts) {
      extrasKickPending = false;
      void (async () => {
        try {
          const notes = await readNotifications();
          unreadByWorkspaceId = new Map(notes.unreadCountsByWorkspaceId);
          paintMirrorFromCache();
        } catch {
          // keep previous unread map
        }
      })();
    }
    await Bun.sleep(150);
  }
}

/**
 * Event-driven fast path: cmux announces window/workspace/agent changes on its event stream,
 * and focus is a window-category change. Events only set a pending flag — never dropped
 * because a sweep happens to be running. The server computes event→mirror latency on the
 * fast path and records it for the header and the measure harness.
 */
let kickPending = false;
let lastEventAt = 0;
let lastEventMirrorMs: number | null = null;

function startEventKicker(): void {
  subscribeToCmuxEvents({
    onChange(scopes) {
      // workspace.renamed is category `workspace` → liveness + workspaceState.
      // Focus is window → liveness. Either must kick the tree-only path.
      if (scopes.has("liveness") || scopes.has("workspaceState")) {
        lastEventAt = Date.now();
        kickPending = true;
      }
      if (scopes.has("notifications")) extrasKickPending = true;
      if (scopes.has("workspaceState")) extrasKickPending = true;
    },
    onFrame(frame, scopes) {
      if (!scopes.has("status")) return;
      const workspace = workspaceIdFromFrame(frame);
      if (workspace) statusKickIds.add(workspace);
      else {
        for (const surface of lastTreeFacts?.surfaces ?? []) {
          statusKickIds.add(surface.workspaceId);
        }
      }
    },
  });
}

function startCatalogueWatch(): void {
  reloadCatalogue();
  try {
    watch(CATALOGUE_PATH(), { persistent: false }, () => {
      catalogueKickPending = true;
    });
  } catch {
    // Missing catalogue is fine; the slow cycle still polls it.
  }
}

interface StatePayload {
  now: number;
  cycles: number;
  sweeping: boolean;
  lastSweepAt: number;
  lastActivitySweepAt: number;
  lastEventAt: number;
  lastEventMirrorMs: number | null;
  store: string;
  mirror: Mirror;
  driftCount: number;
  resolved: ResolvedCondition[];
}

function statePayload(): StatePayload {
  return {
    now: Date.now(),
    cycles,
    sweeping,
    lastSweepAt,
    lastActivitySweepAt,
    lastEventAt,
    lastEventMirrorMs,
    store: CLAUDE_STORE,
    mirror: latestMirror,
    driftCount: [...conditions.values()].filter((c) => c.active).length,
    resolved: recentlyResolved.slice(0, 12),
  };
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sidebar ground truth — live mirror</title>
<style>
  :root{--bg:#101216;--card:#181b21;--line:#262a33;--ink:#dfe3ea;--dim:#8a919e;
        --ok:#2fae7d;--bad:#e5534b;--warn:#d29922;--mono:"SF Mono",ui-monospace,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,"SF Pro Text",sans-serif}
  header{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:1}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--ok);animation:pulse 1.6s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
  header h1{font-size:15px;margin:0;font-weight:600}
  header .meta{color:var(--dim);font-size:12px;font-family:var(--mono)}
  main{padding:18px 22px 60px;max-width:1250px;margin:0 auto}
  h3{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em;margin:26px 0 8px}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;font-size:12.5px}
  th{text-align:left;color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;padding:9px 12px;border-bottom:1px solid var(--line)}
  td{padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .v{font-family:var(--mono)}
  .cell-yes{color:var(--ok)} .cell-no{color:var(--bad)} .cell-na{color:var(--dim)}
  .row-bad td{background:rgba(229,83,75,.06)}
  tr.tab-focused td{border-left:3px solid var(--ok);background:rgba(47,174,125,.09)}
  tr.tab-focused td:first-child{padding-left:25px}
  .ident{min-width:280px;max-width:460px}
  .win-gap td{height:18px;padding:0;background:var(--bg);border:none}
  .win-head td{background:#0c0e12;padding:14px 12px 10px;border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim)}
  .win-head .foc{text-transform:none;letter-spacing:0}
  .ws-head td{background:#14171d;padding:10px 12px 6px;border-bottom:none}
  .ws-head .ws{font-size:13.5px;font-weight:550}
  .ws-head .ref{font-family:var(--mono);font-size:10.5px;color:var(--dim);margin-left:8px}
  .tab-row td{padding-top:4px;padding-bottom:8px}
  .tab-row td:first-child{padding-left:28px}
  .tab{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .meta-line{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:2px;font-family:var(--mono);font-size:10.5px;color:var(--dim)}
  .meta-line b{font-weight:500;color:#6b7280;margin-right:4px}
  .foc{color:var(--ok);font-size:10px;font-weight:600;margin-left:6px}
  .pri{color:var(--ok);font-size:10px;font-weight:600;margin-left:6px}
  .kind-tag{color:var(--warn);font-size:11px}
  .pillchip{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);background:var(--line);white-space:nowrap}
  footer{margin-top:30px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px;line-height:1.8}
  .legend{color:var(--dim);font-size:12px;margin:4px 0 14px}
</style>
</head>
<body>
<header>
  <div class="dot" id="dot"></div>
  <h1>Sidebar ground truth — live mirror</h1>
  <span class="meta" id="meta">connecting…</span>
</header>
<main>
  <h3>Live surfaces — what cmux binds, measured fresh</h3>
  <div class="legend">Each cell is an independent measurement, not another tracked claim. Check any row against your own tabs.</div>
  <table><thead><tr>
    <th>Session</th><th>In tree</th><th>Pill (cmux)</th><th>Hooks say</th><th>Pid alive</th><th>Transcript</th>
  </tr></thead><tbody id="live"></tbody></table>

  <h3>Ghosts — tracked by the hook store, contradicted by measurements</h3>
  <table><thead><tr>
    <th>Session</th><th>Claims</th><th>Surface in tree</th><th>Pid alive</th><th>Transcript on disk</th>
  </tr></thead><tbody id="ghosts"></tbody></table>

  <p class="legend" id="unbound"></p>

  <footer>
    How to verify a row by hand: the <b>tree</b> cell says whether that surface really exists among your open
    cmux workspaces; the <b>pid</b> cell is the kernel's answer to "is that claude process alive"; the
    <b>transcript</b> cell is the filesystem's. If a live row here and your actual tab disagree, tracking is
    wrong — note the row's session id. If everything agrees but the real sidebar still reads stale, the bug
    is delivery/redraw, not data.
  </footer>
</main>
<script>
function ago(t){return Math.max(0,Math.round((Date.now()-t)/1000));}
function fmtElapsed(ms){
  const s=Math.floor(ms/1000);
  if(s<1)return null;
  if(s<60)return s+"s";
  if(s<3600)return Math.floor(s/60)+"m "+(s%60)+"s";
  return Math.floor(s/3600)+"h "+Math.floor((s%3600)/60)+"m";
}
function isWorking(r){
  const label=(r.authoritativePill||r.derivedLabel||r.trackedLifecycle||"").toLowerCase();
  return label==="running"||label==="working";
}
const workingStarted={};
function observeWorking(rows){
  const ids=new Set();
  for(const r of rows){
    if(!r.sessionId||!isWorking(r))continue;
    ids.add(r.sessionId);
    if(workingStarted[r.sessionId]==null)workingStarted[r.sessionId]=Date.now();
  }
  for(const id of Object.keys(workingStarted)) if(!ids.has(id)) delete workingStarted[id];
}
let lastState=null;
let sse=null;
async function tick(){
  try{
    const r=await fetch("/api/state");const d=await r.json();lastState=d;render(d);
  }catch(e){document.getElementById("meta").textContent="server unreachable";
    document.getElementById("dot").style.background="#e5534b";}
}
function connectSSE(){
  try{
    sse=new EventSource("/api/events");
    sse.onmessage=e=>{try{const d=JSON.parse(e.data);lastState=d;render(d);}catch{}};
    sse.onerror=()=>{try{sse.close();}catch{};sse=null;};
  }catch{}
}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;");}
function yn(b){return b===null?'<span class="cell-na">—</span>':b?'<span class="cell-yes">✓ yes</span>':'<span class="cell-no">✗ no</span>';}
function tstate(s){return s==="present"?'<span class="cell-yes">✓ on disk</span>'
  :s==="renamed"?'<span class="cell-na">renamed</span>':'<span class="cell-no">✗ gone</span>';}
function render(d){
  const allTabs=[];
  for(const w of d.mirror.windows||[]) for(const g of w.workspaces||[]) allTabs.push.apply(allTabs,g.tabs||[]);
  if(allTabs.length===0) allTabs.push.apply(allTabs,d.mirror.live||[]);
  observeWorking(allTabs);
  document.getElementById("dot").style.background=d.sweeping?"#d29922":"#2fae7d";
  document.getElementById("meta").textContent=
    "cycle "+d.cycles+" · last sweep "+ago(d.lastSweepAt)+"s ago · activity "+ago(d.lastActivitySweepAt)+"s ago · "+
    "event→mirror: "+(d.lastEventMirrorMs===null?"no events yet":(d.lastEventAt?ago(d.lastEventAt)+"s ago, took "+d.lastEventMirrorMs+"ms":"none"))+" · "+
    d.mirror.live.length+" live / "+d.mirror.ghosts.length+" ghosts";
  const live=document.getElementById("live");live.innerHTML="";
  const windows=d.mirror.windows&&d.mirror.windows.length
    ?d.mirror.windows
    :[{windowRef:"",windowFocused:false,workspaces:d.mirror.groups&&d.mirror.groups.length?d.mirror.groups:[{workspaceRef:"",workspaceTitle:null,workspaceFocused:false,tabs:d.mirror.live}]}];
  let winIndex=0;
  for(const win of windows){
    if(winIndex>0){
      const gap=document.createElement("tr");gap.className="win-gap";
      gap.innerHTML='<td colspan="6"></td>';
      live.appendChild(gap);
    }
    winIndex+=1;
    const whead=document.createElement("tr");whead.className="win-head";
    whead.innerHTML='<td colspan="6">'+esc(win.windowRef||"window")+(win.windowFocused?' <span class="foc">focused window</span>':"")+"</td>";
    live.appendChild(whead);
    for(const g of win.workspaces){
    const head=document.createElement("tr");head.className="ws-head";
    const wsBadges=[];
    if(g.pinned)wsBadges.push('<span class="pri">pinned</span>');
    if(g.shortcut)wsBadges.push('<span class="pri">⌘'+g.shortcut+"</span>");
    if(g.unread)wsBadges.push('<span class="foc">'+g.unread+" unread</span>");
    head.innerHTML='<td colspan="6"><span class="ws">'+esc(g.workspaceTitle||"(unnamed workspace)")+(g.workspaceFocused?' <span class="foc">selected</span>':"")+'</span>'+wsBadges.join(" ")+'<span class="ref">'+esc(g.workspaceRef)+"</span></td>";
    live.appendChild(head);
    for(const r of g.tabs){
      const unbound=r.kind==="unbound";
      const bad=!unbound&&((r.authoritativePill&&r.derivedLabel&&r.authoritativePill!==r.derivedLabel)||r.transcriptState==="absent");
      const tr=document.createElement("tr");tr.className="tab-row"+(bad?" row-bad":"")+(r.surfaceFocused?" tab-focused":"");
      const badges=[];
      if(r.primary)badges.push('<span class="pri">primary</span>');
      if(r.surfaceFocused)badges.push('<span class="foc">focused tab</span>');
      const extras=[];
      if(r.project)extras.push("<span><b>project</b>"+esc(r.project)+"</span>");
      if(r.worktree)extras.push("<span><b>worktree</b>"+esc(r.worktree)+"</span>");
      if(r.branch)extras.push("<span><b>branch</b>"+esc(r.branch)+"</span>");
      if(r.cwd)extras.push("<span><b>cwd</b>"+esc(r.cwd)+"</span>");
      if(r.messageCount!=null)extras.push("<span><b>msgs</b>"+r.messageCount+"</span>");
      const working=r.sessionId&&isWorking(r)?fmtElapsed(Date.now()-(workingStarted[r.sessionId]||Date.now())):null;
      if(working)extras.push("<span><b>working</b>"+working+"</span>");
      if(r.lastActivityAt)extras.push("<span><b>indexed</b>"+ago(r.lastActivityAt)+"s</span>");
      if(r.models&&r.models.length)extras.push("<span><b>last billed</b>"+esc(r.models[r.models.length-1])+"</span>");
      if(r.enrichmentState)extras.push("<span><b>state</b>"+esc(r.enrichmentState)+"</span>");
      if(r.enrichmentNext)extras.push("<span><b>next</b>"+esc(r.enrichmentNext)+"</span>");
      if(r.enrichmentRecommendation)extras.push("<span><b>rec</b>"+esc(r.enrichmentRecommendation)+"</span>");
      const ident=unbound
        ?'<div class="kind-tag">not a Claude Code session</div>'
        :'<div class="tab">ccs · '+esc(r.title||"no title yet")+(r.catalogueLifecycle?' · '+esc(r.catalogueLifecycle):"")+"</div>"+
         '<div class="meta-line"><span><b>uuid</b>'+esc(r.sessionId)+"</span></div>";
      tr.innerHTML='<td class="ident"><div class="tab">'+esc(r.surfaceTitle||"(unnamed tab)")+badges.join(" ")+"</div>"+ident+
        (extras.length?'<div class="meta-line">'+extras.join("")+"</div>":"")+"</td>"+
        '<td>'+yn(true)+'</td>'+
        '<td class="v">'+(unbound?'<span class="cell-na">—</span>':'<span class="pillchip">'+esc(r.authoritativePill??"not swept yet")+'</span>')+'</td>'+
        '<td class="v">'+(unbound?'<span class="cell-na">—</span>':esc(r.derivedLabel??r.trackedLifecycle??"—"))+'</td>'+
        '<td>'+(unbound?'<span class="cell-na">—</span>':(r.pidAlive===null?'<span class="cell-na">idle claim</span>':yn(r.pidAlive)))+'</td>'+
        '<td>'+(unbound?'<span class="cell-na">—</span>':tstate(r.transcriptState))+"</td>";
      live.appendChild(tr);
    }
    }
  }
  if(d.mirror.live.length===0)live.innerHTML='<tr><td colspan="6" style="color:var(--dim)">no bound sessions observed yet</td></tr>';
  const gh=document.getElementById("ghosts");gh.innerHTML="";
  for(const r of d.mirror.ghosts){
    const tr=document.createElement("tr");tr.className="row-bad";
    tr.innerHTML='<td><div class="title">'+esc(r.title||"(untitled)")+'</div><span class="sid">'+r.sessionId.slice(0,8)+'</span></td>'+
      '<td class="v">'+esc(r.trackedLifecycle??"—")+(r.surfaceId?" @ "+r.surfaceId.slice(0,8):"")+'</td>'+
      '<td>'+yn(false)+'</td>'+
      '<td>'+(r.pidAlive===null?'<span class="cell-na">—</span>':yn(r.pidAlive))+'</td>'+
      "<td>"+tstate(r.transcriptState)+"</td>";
    gh.appendChild(tr);
  }
  if(d.mirror.ghosts.length===0)gh.innerHTML='<tr><td colspan="5" style="color:var(--ok)">no ghosts — every tracked session has a real surface</td></tr>';
  const unboundN=d.mirror.live.filter(r=>r.kind==="unbound").length;
  document.getElementById("unbound").textContent=unboundN===0?"":(unboundN+" workspace"+(unboundN===1?"":"s")+" in the table have no Claude session (browser / terminal / other).");
}
tick();connectSSE();setInterval(tick,3000);setInterval(function(){if(lastState)render(lastState);},1000);
</script>
</body>
</html>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/state") {
      return Response.json(statePayload());
    }
    if (url.pathname === "/api/events") {
      let closed = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const enc = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          sseClients.add(controller);
          c.enqueue(enc.encode(`: connected\n\n`));
        },
        cancel() {
          closed = true;
          sseClients.delete(controller);
        },
      });
      // Bun closes the response when the request is aborted; hook that to clean up.
      req.signal.addEventListener("abort", () => {
        if (!closed) sseClients.delete(controller);
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
    if (url.pathname === "/healthz") {
      return new Response("ok");
    }
    if (url.pathname === "/") {
      return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
});

process.stdout.write(`sidebar ground truth live at http://127.0.0.1:${PORT}/\n`);
startEventKicker();
startCatalogueWatch();
void sweepLoop();

export { server };
