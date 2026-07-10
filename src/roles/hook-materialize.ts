/**
 * Materialize ccs-managed HOOKS into a settings.json `hooks` object (ADR-0018/0029/0034).
 *
 * settings.json is strict JSON with the user's own important hooks (island-state, telemetry,
 * …), so we can't use text BEGIN/END markers. Instead each ccs-managed hook command carries a
 * sentinel key (MANAGED_TAG). On each sync we:
 *   - drop every existing ccs-managed entry (identified by the tag), leaving the user's alone,
 *   - add the current desired ccs entries,
 *   - prune any event key left empty.
 * So ccs owns only its tagged entries; the user's hooks are never touched. Idempotent:
 * re-syncing replaces ccs's entries rather than duplicating them.
 *
 * Pure: takes the parsed settings object + desired ccs hooks, returns the new object. The I/O
 * (read/atomic-write settings.json) lives in the caller (sync-roles).
 */

/** Sentinel key marking a hook command as ccs-managed (so we can find + prune only our own). */
export const MANAGED_TAG = "__ccsManaged";

export interface HookCommand {
  type: string;
  command: string;
  [MANAGED_TAG]?: boolean;
  [k: string]: unknown;
}
export interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}
export interface DesiredHook {
  event: string;
  entry: HookEntry;
}
interface SettingsLike {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

const isManagedEntry = (e: HookEntry): boolean =>
  Array.isArray(e.hooks) && e.hooks.some((h) => h[MANAGED_TAG] === true);

/**
 * Merge the desired ccs-managed hooks into `settings`, replacing ccs's prior managed entries
 * and preserving everything else. Returns a NEW object (does not mutate the input).
 */
export function mergeManagedHooks(
  settings: SettingsLike,
  desired: DesiredHook[],
): SettingsLike & { hooks: Record<string, HookEntry[]> } {
  // deep-ish clone of the hooks map so we never mutate the caller's object
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    // keep only the user's (non-ccs) entries; ccs's prior entries are dropped + re-added below
    const userEntries = (entries ?? []).filter((e) => !isManagedEntry(e));
    if (userEntries.length) hooks[event] = userEntries;
  }

  // add the current desired ccs entries
  for (const d of desired) {
    (hooks[d.event] ??= []).push(d.entry);
  }

  // prune any event key that ended up empty (had only ccs hooks, now none desired)
  for (const event of Object.keys(hooks)) {
    if (hooks[event]!.length === 0) delete hooks[event];
  }

  return { ...settings, hooks };
}
