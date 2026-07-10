import type { CatalogueRow } from "../catalogue/db.ts";
import { resolveRole, ccsConfigRoot } from "../roles/role-files.ts";
import { ccsRuntimeRoot } from "../inbox/identity-path.ts";
import { resolveConfig } from "./resolve-config.ts";
import { renderSections, type Section } from "./merge.ts";
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

/** Resolve + render the layered claude-md for a row. Never throws. */
export function composeClaudeMd(row: CatalogueRow): ComposedClaudeMd {
  try {
    const res = resolveConfig(row, "claude-md", liveResolveCtx());
    const sections = (res.effective as Section[] | null) ?? [];
    const rendered = renderSections(sections);
    return { context: rendered.length > 0 ? rendered : null, degraded: res.degraded };
  } catch {
    return { context: null, degraded: false }; // fail-open: a hook must never block
  }
}
