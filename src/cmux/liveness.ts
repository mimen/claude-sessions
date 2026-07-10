/**
 * Surface-keyed liveness, built on the cmux bridge (ADR-0014/0016/0040).
 *
 * Replaces the title-join in open-state.ts and the cwd-match in live-by-cwd.ts: those
 * predated cmux exposing the surface UUID, so they guessed via title/cwd (ambiguous when
 * sessions share a title or directory). The bridge keys on the surface UUID — the exact,
 * shared join key between `cmux tree --all` and cmux's persisted state — so liveness is
 * exact, with no title/cwd guessing.
 *
 * Pure `*From(bridge, …)` functions are fixture-tested; the `live*` wrappers add I/O.
 */
import { execFileSync } from "node:child_process";
import { type Bridge, type SurfaceLocation } from "./bridge";
import { liveBridge } from "./live";

/** Every Claude session id that currently has a live surface (i.e. is open). */
export function openSessionIdsFrom(bridge: Bridge): Set<string> {
  const ids = new Set<string>();
  for (const s of bridge.surfaces) {
    const info = bridge.surfaceInfo(s.surfaceId);
    if (info) ids.add(info.sessionId);
  }
  return ids;
}

/** The live workspace a session is currently embodied in, or null if closed. */
export function workspaceForSessionFrom(
  bridge: Bridge,
  sessionId: string,
): SurfaceLocation | null {
  return bridge.locateSession(sessionId);
}

export interface PrimaryWorkspace extends SurfaceLocation {
  /** true iff this session's surface is the workspace's tab-owning primary (ADR-0027/0040). */
  isPrimary: boolean;
}

/**
 * A session's workspace plus whether it OWNS that workspace's tab (it's the primary =
 * earliest claude-surface). Non-primary sessions must skip painting the tab (ADR-0027).
 */
export function primaryWorkspaceForSessionFrom(
  bridge: Bridge,
  sessionId: string,
): PrimaryWorkspace | null {
  const loc = bridge.locateSession(sessionId);
  if (!loc) return null;
  const primary = bridge.primarySurface(loc.workspaceId);
  return { ...loc, isPrimary: primary?.surfaceId === loc.surfaceId };
}

// --- live wrappers (build a bridge from the machine's cmux state) ---------------

/** Live: every open Claude session id, from the current cmux state. */
export function openSessionIds(): Set<string> {
  return openSessionIdsFrom(liveBridge());
}

/** Live: the workspace a session is embodied in right now, or null if closed. */
export function workspaceForSession(sessionId: string): SurfaceLocation | null {
  return workspaceForSessionFrom(liveBridge(), sessionId);
}

/** Live: the session's workspace + whether it owns the tab. */
export function primaryWorkspaceForSession(
  sessionId: string,
): PrimaryWorkspace | null {
  return primaryWorkspaceForSessionFrom(liveBridge(), sessionId);
}

/**
 * Push a workspace rename to cmux if the session is currently open there, resolving the
 * workspace by SURFACE UUID (exact, ADR-0040) — no cwd/title guess. Returns success.
 */
export function pushCmuxRename(sessionId: string, title: string, cmuxBin = "cmux"): boolean {
  const loc = workspaceForSession(sessionId);
  if (!loc) return false;
  try {
    // `rename-workspace --workspace <ref> -- <title>`; `--` guards dash-leading titles.
    execFileSync(cmuxBin, ["rename-workspace", "--workspace", loc.workspaceRef, "--", title], {
      timeout: 4000,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
