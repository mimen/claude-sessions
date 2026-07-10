import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { CatalogueRow } from "../catalogue/db.ts";
import { getRoleDef } from "../catalogue/db.ts";
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

/** The config root (definitions). Honors $CCS_CONFIG_ROOT, else ~/.ccs-config (ADR-0041). */
export function ccsConfigRoot(): string {
  return process.env.CCS_CONFIG_ROOT ?? join(process.env.HOME ?? "", ".ccs-config");
}

/** Build the live resolve ctx (role home_dir from the registry + the two roots). */
export function liveResolveCtx(db: Database): ResolveCtx {
  return {
    configRoot: ccsConfigRoot(),
    runtimeRoot: ccsRuntimeRoot(),
    roleHomeDir: (role) => getRoleDef(db, role)?.homeDir ?? null,
  };
}

export interface ComposedClaudeMd {
  /** Rendered context string, or null if no section had a body. */
  context: string | null;
  /** True if a layer was corrupt (session should be flagged degraded). */
  degraded: boolean;
}

/** Resolve + render the layered claude-md for a row. Never throws. */
export function composeClaudeMd(db: Database, row: CatalogueRow): ComposedClaudeMd {
  try {
    const res = resolveConfig(row, "claude-md", liveResolveCtx(db));
    const sections = (res.effective as Section[] | null) ?? [];
    const rendered = renderSections(sections);
    return { context: rendered.length > 0 ? rendered : null, degraded: res.degraded };
  } catch {
    return { context: null, degraded: false }; // fail-open: a hook must never block
  }
}
