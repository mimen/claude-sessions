import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CatalogueRow } from "../catalogue/db.ts";
import { resolveConfig } from "./resolve-config.ts";
import { liveResolveCtx } from "./compose-claude-md.ts";
import type { Action } from "./merge.ts";

/**
 * The `spawn` hook action runner (ADR-0075): a role's BIRTH setup. When `ccs new-session` mints a
 * session, it resolves the row's layered `spawn` config (an ORDERED list of actions) and EXECUTES
 * each — deterministic filesystem prep that a worker needs to run correctly headless, expressed
 * declaratively instead of in a bespoke cluster shell script. Mirrors `start-actions` (the same
 * ordered-actions/fail-open shape), but fires at new-session and does filesystem side effects
 * rather than surfacing context.
 *
 * The two built-ins generalize what pr-watch's spawn-agent.sh did by hand:
 *  - grant-perms: write a `.claude/settings.local.json` in the launch cwd allowing Write/Edit +
 *    the Bash commands a headless worker must run, so it never stalls on a permission prompt.
 *  - seed-files: pre-create the worker's state files ({}) so its first write is an EDIT, not a
 *    CREATE (which prompts under acceptEdits).
 *
 * Deterministic + fail-open: an action that throws is recorded and skipped; the rest still run
 * (a spawn must never be blocked by a best-effort setup step). The handler table is injectable so
 * the runner is testable without touching a real cwd.
 */

export interface SpawnActionCtx {
  row: CatalogueRow;
  /** The launch cwd (the worker's worktree, or the role's home dir) — where setup writes. */
  cwd: string;
}

export interface SpawnActionOutcome {
  /** A problem to record (action still counts as run; fail-open). */
  error?: string;
}

export type SpawnActionHandler = (action: Action, ctx: SpawnActionCtx) => SpawnActionOutcome;

/** Merge an object of allow-rules into a .claude/settings.local.json in cwd (never clobber). */
function mergeSettingsLocal(cwd: string, allow: string[], statusLine?: string): void {
  const dir = join(cwd, ".claude");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "settings.local.json");
  let doc: { permissions?: { allow?: string[] }; statusLine?: unknown } = {};
  if (existsSync(path)) {
    try { doc = JSON.parse(readFileSync(path, "utf8")); } catch { doc = {}; }
  }
  doc.permissions ??= {};
  const existing = new Set(doc.permissions.allow ?? []);
  for (const rule of allow) existing.add(rule);
  doc.permissions.allow = [...existing];
  if (statusLine) doc.statusLine = { type: "command", command: statusLine };
  writeFileSync(path, JSON.stringify(doc, null, 2) + "\n");
}

/** Substitute {cwd} / {home} placeholders in an authored allow-rule. */
function expand(rule: string, cwd: string): string {
  return rule.replaceAll("{cwd}", cwd).replaceAll("{home}", process.env.HOME ?? "");
}

/** Built-in spawn-action handlers. Each is deterministic and fail-open. */
export const BUILTIN_SPAWN_ACTIONS: Record<string, SpawnActionHandler> = {
  // grant-perms: write allow-rules (+ optional statusLine) into the launch cwd's
  // .claude/settings.local.json so a headless session doesn't stall on permission prompts.
  // The action's `allow` list is authored in the role's spawn.json; {cwd}/{home} expand.
  "grant-perms": (action, ctx) => {
    const a = action as Action & { allow?: string[]; statusLine?: string };
    const rules = (a.allow ?? []).map((r) => expand(r, ctx.cwd));
    mergeSettingsLocal(ctx.cwd, rules, a.statusLine);
    return {};
  },

  // seed-files: pre-create files (with `{}` if absent) so the first write is an edit, not a
  // create-prompt. The action's `files` list is relative to cwd (authored in spawn.json).
  "seed-files": (action, ctx) => {
    const a = action as Action & { files?: string[] };
    for (const rel of a.files ?? []) {
      const p = join(ctx.cwd, expand(rel, ctx.cwd));
      if (existsSync(p)) continue;
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "{}\n");
    }
    return {};
  },
};

/** Every spawn-action name with a built-in handler (for `ccs hooks lint` to flag typos). */
export function knownSpawnActions(): string[] {
  return Object.keys(BUILTIN_SPAWN_ACTIONS);
}

/**
 * Resolve + run a row's `spawn` actions at birth. Returns which ran + any errors. Fail-open: a
 * missing config or a throwing action never blocks the spawn. `cwd` is the launch dir.
 */
export function runSpawnActions(
  ctx: SpawnActionCtx,
  handlers: Record<string, SpawnActionHandler> = BUILTIN_SPAWN_ACTIONS,
): { ran: string[]; errors: string[] } {
  let actions: Action[] = [];
  try {
    const res = resolveConfig(ctx.row, "spawn", liveResolveCtx());
    actions = (res.effective as Action[] | null) ?? [];
  } catch {
    return { ran: [], errors: ["spawn config unresolved"] };
  }
  const ran: string[] = [];
  const errors: string[] = [];
  for (const action of actions) {
    const handler = handlers[action.name];
    if (!handler) { errors.push(`no handler for spawn action "${action.name}"`); continue; }
    try {
      const out = handler(action, ctx);
      ran.push(action.name);
      if (out.error) errors.push(out.error);
    } catch (e) {
      errors.push(`spawn action "${action.name}" threw: ${(e as Error).message}`);
    }
  }
  return { ran, errors };
}
