import type { CatalogueRow } from "../catalogue/db.ts";
import { resolveRole, ccsConfigRoot } from "../roles/role-files.ts";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";
import { resolveConfig } from "./resolve-config.ts";
import { renderSections, type Section } from "./merge.ts";
import { getGrouping } from "../state/groupings.ts";
import type { ResolveCtx } from "./resolve-levels.ts";

/**
 * Compose a session's layered `claude-md` context (ADR-0043/0044): resolve every applicable
 * level's `claude-md.md`, merge the sections (floor-protected), and render to the string a
 * SessionStart hook injects as `additionalContext`. This is CONTEXT COMPOSITION — the session
 * wakes up knowing its identity + cluster constitution + epic gotchas + role brief, resolved
 * from its row (ADR-0043), not from a per-session prompt.
 *
 * Best-effort by design: a missing/empty tree yields null (nothing injected); a corrupt layer is
 * dropped and the valid layers still compose (ADR-0045). Never throws — the caller is a hook.
 */

/** Build the live resolve ctx. Roles resolve from config FILES now (ADR-0050), so no db. */
export function liveResolveCtx(): ResolveCtx {
  return {
    configRoot: ccsConfigRoot(),
    runtimeRoot: ccsRuntimeRoot(),
    roleHomeDir: (role) => resolveRole(role)?.homeDir ?? null,
  };
}

export interface ComposedClaudeMd {
  /** Rendered context string, or null if no section had a body. */
  context: string | null;
  /** True if a layer was corrupt (session should be flagged degraded). */
  degraded: boolean;
}

/** Resolve + render the layered claude-md for a row, then append the grouping's accumulated
 * NOTES (ADR-0051: a grouping's context = authored config sections + agent-accumulated runtime
 * notes). The authored context comes from the config layers; the notes from cluster runtime
 * state. Never throws. */
export function composeClaudeMd(row: CatalogueRow): ComposedClaudeMd {
  try {
    const res = resolveConfig(row, "claude-md", liveResolveCtx());
    const sections = (res.effective as Section[] | null) ?? [];
    const parts = [renderSections(sections)];
    // Grouping notes: project-level memory accumulated by agents (ADR-0051), injected after the
    // authored context. Runtime state, so it grows as the initiative is worked.
    if (row.cluster && row.epicId) {
      const g = getGrouping(row.cluster, row.epicId);
      if (g && g.notes.length > 0) {
        parts.push(`## grouping-notes\n${g.notes.map((n) => `- ${n}`).join("\n")}`);
      }
    }
    const rendered = parts.filter((p) => p.length > 0).join("\n\n");
    return { context: rendered.length > 0 ? rendered : null, degraded: res.degraded };
  } catch {
    return { context: null, degraded: false }; // fail-open: a hook must never block
  }
}

/**
 * Resolve + render a session's layered `stop-context` — the TEXT injected at turn-END (ADR-0063).
 * Same section-merge machinery as claude-md, but for the `stop-context` hook type: a role/cluster
 * authors a `.ccs-hooks/stop-context.md` fragment (e.g. pr-agent's per-turn phase self-check) and
 * the tool resolves + injects it, keyed on FILE PRESENCE, never a hardcoded role name. Returns null
 * when no level authored one (nothing injected). Never throws — the caller is a Stop hook.
 */
export function composeStopContext(row: CatalogueRow): string | null {
  try {
    const res = resolveConfig(row, "stop-context", liveResolveCtx());
    const sections = (res.effective as Section[] | null) ?? [];
    const rendered = renderSections(sections);
    return rendered.length > 0 ? rendered : null;
  } catch {
    return null; // fail-open
  }
}
