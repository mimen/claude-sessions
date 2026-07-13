/**
 * `ccs reap-duplicates` — find and close DUPLICATE live embodiments of the same Claude session.
 *
 * A duplicate happens when the liveness check was blind (see the bridge 0.64.17 union fix in
 * bridge.ts): `ccs resume-cluster` thought a session was closed while a real `claude --resume
 * <sid>` was still running, so it spawned a second workspace running another `--resume <sid>`.
 * Now there are two live processes for the same identity, each on its own cmux workspace.
 *
 * Truth source for duplicates is `ps`, not the hook store — the store's `activeSessionsBySurface`
 * is the very thing the liveness check was misreading, so we can't rely on it to find twins.
 *
 * WHICH TWIN TO KEEP — CPU-time ranking. Both twins share the same JSONL on disk, but they hold
 * DIVERGED in-memory transcripts: the one the operator actually talked to has processed messages
 * and burned real CPU; the abandoned twin sits ~0. Pick the higher-CPU twin. When the top two
 * are within CPU_TIE_EPSILON, we can't confidently pick one → close ALL twins and let the next
 * resume rehydrate one fresh from the JSONL. That intentionally loses any in-memory-only state
 * neither twin has flushed, but avoids picking the wrong one and clobbering the good history.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { SurfaceLocation } from "./bridge.ts";

interface LiveProc {
  pid: string;
  tty: string;
  sessionId: string;
  /** Accumulated CPU seconds — the "who did work" signal. A twin that a user actually talked to
   * spends CPU streaming the model / applying tools; the abandoned twin sits ~0. Turns "which
   * process has the up-to-date in-memory transcript" into an observable number. */
  cpuSeconds: number;
}

/** Parse ps `cputime` string ("0:11.62", "1:11.32", or "1-02:03:04" for >24h) into seconds. */
export function parseCpuTime(s: string): number {
  const trimmed = s.trim();
  // "d-hh:mm:ss(.ss)"
  const dm = trimmed.match(/^(\d+)-(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (dm) return +dm[1]! * 86400 + +dm[2]! * 3600 + +dm[3]! * 60 + +dm[4]!;
  const parts = trimmed.split(":");
  if (parts.length === 3) return +parts[0]! * 3600 + +parts[1]! * 60 + +parts[2]!;
  if (parts.length === 2) return +parts[0]! * 60 + +parts[1]!;
  return Number.isFinite(+trimmed) ? +trimmed : 0;
}

/** Enumerate live `claude --resume <sessionId>` processes on this machine via `ps`. */
export function liveClaudeResumeProcs(): LiveProc[] {
  let out = "";
  try {
    out = execFileSync("ps", ["-ax", "-o", "pid,tty,cputime,command"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const procs: LiveProc[] = [];
  // pid, tty, cputime, then command starts (cputime is "M:SS.ss", "H:MM:SS.ss", or "D-HH:MM:SS")
  const re = /^\s*(\d+)\s+(\S+)\s+([\d:.\-]+)\s+.*--resume\s+([0-9a-f-]{36})/i;
  for (const line of out.split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    procs.push({
      pid: m[1]!,
      tty: m[2]!,
      sessionId: m[4]!.toLowerCase(),
      cpuSeconds: parseCpuTime(m[3]!),
    });
  }
  return procs;
}

export interface DuplicateGroup {
  sessionId: string;
  procs: LiveProc[];
  /** the workspace we would keep — the twin with the most CPU-time (= actually did work). `null`
   * when no twin looks distinguishable from the others (all within CPU_TIE_EPSILON) — in that
   * case we close every embodiment and let the next resume rehydrate one fresh from the JSONL. */
  keep: { procTty: string; cpuSeconds: number; workspace: SurfaceLocation } | null;
  /** the workspaces we would close (all in-cmux twins other than `keep`; if `keep` is null,
   * these are ALL the in-cmux twins). */
  drop: { procTty: string; cpuSeconds: number; workspace: SurfaceLocation }[];
  /** procs we couldn't tie to a live cmux workspace (e.g. running outside cmux) — left alone */
  orphans: LiveProc[];
  /** why we can't pick a keep, when keep is null (helpful in `--do` output) */
  keepReason?: "cpu-tie" | "no-workspace";
}

/** Two twins are "indistinguishable" if their CPU-time is within this many seconds. Empirically
 * a re-attached-but-untouched claude burns ~a few seconds of CPU on startup; a talked-to twin
 * is >>10s. 5s is a comfortable gap. */
export const CPU_TIE_EPSILON = 5;

/** Build `tty basename -> workspace ref` from a live cmux tree read. Pulls tty (which the bridge
 * doesn't retain) directly from the raw tree JSON; kept local so callers stay simple. */
function ttyMapFromLiveTree(): Map<string, SurfaceLocation> {
  // The bridge doesn't carry tty. We re-read the tree here; this is a small enough op the reap
  // command doesn't need a whole new bridge layer. Kept inside the module so callers stay simple.
  const out = new Map<string, SurfaceLocation>();
  try {
    const raw = execFileSync("cmux", ["tree", "--all", "--json", "--id-format", "both"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tree = JSON.parse(raw) as {
      windows?: {
        id: string; ref: string;
        workspaces?: {
          id: string; ref: string; title?: string | null;
          panes?: {
            id: string; ref: string; index?: number;
            surfaces?: { id: string; ref: string; type?: string; title?: string | null; index_in_pane?: number; tty?: string | null }[];
          }[];
        }[];
      }[];
    };
    for (const w of tree.windows ?? []) for (const ws of w.workspaces ?? []) for (const p of ws.panes ?? []) for (const s of p.surfaces ?? []) {
      if (!s.tty) continue;
      const loc: SurfaceLocation = {
        surfaceId: s.id,
        surfaceRef: s.ref,
        surfaceType: s.type ?? null,
        title: s.title ?? null,
        paneId: p.id,
        paneIndex: p.index ?? 0,
        indexInPane: s.index_in_pane ?? 0,
        workspaceId: ws.id,
        workspaceRef: ws.ref,
        workspaceTitle: ws.title ?? null,
        windowId: w.id,
        windowRef: w.ref,
      };
      out.set(basename(s.tty), loc);
    }
  } catch {
    /* tree unreadable → empty map, callers see everything as orphan */
  }
  return out;
}

/**
 * Compute the reap plan from a `ps` snapshot + a tty→workspace map. Pure: no side effects, so
 * it's fixture-testable.
 *
 * Ranking: the twin with the most CPU-time wins — it's the one that actually processed messages
 * (streamed model output, ran tools) and therefore holds the up-to-date in-memory transcript.
 * The abandoned twin sits at near-zero CPU. When the top two are within CPU_TIE_EPSILON we can't
 * distinguish them, so we return `keep=null` and mark ALL twins for close — a fresh resume then
 * reads the on-disk JSONL (both twins wrote to the same file). This intentionally sacrifices any
 * in-memory-only state neither twin has flushed rather than pick the wrong one.
 */
export function planReap(
  procs: LiveProc[],
  ttyToSurface: Map<string, SurfaceLocation>,
): DuplicateGroup[] {
  // sessionId -> its live procs
  const bySession = new Map<string, LiveProc[]>();
  for (const p of procs) {
    const list = bySession.get(p.sessionId) ?? [];
    list.push(p);
    bySession.set(p.sessionId, list);
  }

  const groups: DuplicateGroup[] = [];
  for (const [sessionId, list] of bySession) {
    if (list.length < 2) continue;
    // resolve each proc's cmux workspace via tty
    const resolved = list.map((p) => {
      const ttyName = basename(p.tty);
      return { proc: p, workspace: ttyToSurface.get(ttyName) ?? null };
    });
    const withWorkspace = resolved.filter((r): r is { proc: LiveProc; workspace: SurfaceLocation } => r.workspace !== null);
    const orphans = resolved.filter((r) => r.workspace === null).map((r) => r.proc);

    if (withWorkspace.length === 0) {
      groups.push({ sessionId, procs: list, keep: null, drop: [], orphans, keepReason: "no-workspace" });
      continue;
    }

    // Rank by CPU-time descending. Highest-CPU is the twin that did real work.
    withWorkspace.sort((a, b) => b.proc.cpuSeconds - a.proc.cpuSeconds);
    const [top, second] = withWorkspace;
    const asDrop = (r: { proc: LiveProc; workspace: SurfaceLocation }) => ({
      procTty: r.proc.tty,
      cpuSeconds: r.proc.cpuSeconds,
      workspace: r.workspace,
    });

    // Ambiguous: top two are within epsilon → no confident winner. Close ALL twins; a fresh
    // resume will rehydrate one from the on-disk JSONL. Only trigger this branch when there are
    // exactly two twins AND the diff is small — with 3+ twins where one is clearly ahead, the
    // ambiguity is between the losers and doesn't matter.
    if (second && top && top.proc.cpuSeconds - second.proc.cpuSeconds < CPU_TIE_EPSILON) {
      groups.push({
        sessionId,
        procs: list,
        keep: null,
        drop: withWorkspace.map(asDrop),
        orphans,
        keepReason: "cpu-tie",
      });
      continue;
    }

    const [keep, ...drops] = withWorkspace;
    groups.push({
      sessionId,
      procs: list,
      keep: { procTty: keep!.proc.tty, cpuSeconds: keep!.proc.cpuSeconds, workspace: keep!.workspace },
      drop: drops.map(asDrop),
      orphans,
    });
  }
  return groups;
}

/**
 * `ccs reap-duplicates [--do]` — the CLI entry.
 *   Default: dry-run — print the plan and exit 0.
 *   With --do: `cmux close-workspace` each drop; report per-group success.
 *
 * Closing a workspace is what actually kills the duplicate claude — cmux tears down the pane,
 * which sends SIGHUP to the shell, which kills the child `claude` process. We never `kill -9`
 * the pid ourselves.
 */
export function reapCommand(args: string[]): number {
  const dryRun = !args.includes("--do");
  const procs = liveClaudeResumeProcs();
  const groups = planReap(procs, ttyMapFromLiveTree());

  if (groups.length === 0) {
    console.log("ccs reap-duplicates: no duplicate live sessions found.");
    return 0;
  }

  const header = dryRun ? "would close" : "closing";
  console.log(`ccs reap-duplicates: ${groups.length} session(s) with >1 live embodiment`);
  console.log();

  let closed = 0;
  let failed = 0;
  const cmuxBin = process.env.CMUX_BIN ?? "cmux";

  for (const g of groups) {
    const shortSid = g.sessionId.slice(0, 8);
    console.log(`  ${shortSid}  (${g.procs.length} live procs)`);
    if (g.keep) {
      console.log(
        `    keep:  ${g.keep.workspace.workspaceRef}  tty=${basename(g.keep.procTty)}  cpu=${g.keep.cpuSeconds.toFixed(1)}s  "${g.keep.workspace.workspaceTitle ?? ""}"`,
      );
    } else if (g.keepReason === "cpu-tie") {
      console.log(
        `    keep:  (none — cpu-time within ${CPU_TIE_EPSILON}s, indistinguishable. Closing ALL; next resume rehydrates from JSONL)`,
      );
    } else {
      console.log(`    keep:  (no live cmux workspace found — leaving all procs alone)`);
    }
    for (const d of g.drop) {
      console.log(
        `    ${header}: ${d.workspace.workspaceRef}  tty=${basename(d.procTty)}  cpu=${d.cpuSeconds.toFixed(1)}s  "${d.workspace.workspaceTitle ?? ""}"`,
      );
      if (dryRun) continue;
      try {
        execFileSync(cmuxBin, ["close-workspace", "--workspace", d.workspace.workspaceRef], {
          timeout: 5000,
          stdio: "ignore",
        });
        closed++;
      } catch (e) {
        failed++;
        console.log(`      FAILED: ${(e as Error).message}`);
      }
    }
    for (const o of g.orphans) {
      console.log(`    orphan: tty=${basename(o.tty)} pid=${o.pid} cpu=${o.cpuSeconds.toFixed(1)}s (not in cmux tree — leaving alone)`);
    }
  }

  if (dryRun) {
    console.log();
    console.log("dry run — pass --do to close the duplicate workspaces");
  } else {
    console.log();
    console.log(`closed ${closed}, failed ${failed}`);
  }
  return failed > 0 ? 1 : 0;
}
