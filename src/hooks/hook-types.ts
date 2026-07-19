/**
 * The hook-type registry (ADR-0043/0044): the single, static declaration of every ccs hook
 * type — what CC moment it rides, and HOW its layers combine.
 *
 * The merge strategy is a property of the TYPE, declared here once — never per level, never per
 * file (ADR-0044/0045). The resolver (resolve-levels.ts) returns the ordered layers; the
 * combinator (merge.ts) applies the strategy named here. Keeping this a pure data table means
 * "what does hook X do when it fires, and how does its config combine?" has one answerable home.
 */

/** How a type's per-level configs combine (ADR-0044). */
export type MergeKind =
  | "sections" // claude-md: ordered sections by id; append/replace/suppress, floor sections protected
  | "set-union" // meta-update: union of field-name sets down the chain
  | "ordered-actions" // start/stop: append action lists, explicit ordering, idempotent
  | "union-deny-wins" // guard: all matching run; any deny beats any allow
  | "most-specific"; // cmux-paint/statusline/spawn-location: nearest defined level owns it whole

/** The CC event (or ccs moment) a type fires on. */
export type FiresOn =
  | "SessionStart"
  | "Stop"
  | "PreToolUse"
  | "statusLine" // the settings.json statusLine slot, not a hook event
  | "new-session"; // a ccs moment (pre-row) — spawn-location only

/** A hook type's static declaration. */
export interface HookTypeDef {
  type: string;
  firesOn: FiresOn;
  merge: MergeKind;
  /** Config file format(s) this type accepts (ADR-0045: one format per (level,type) slot). */
  formats: ReadonlyArray<"md" | "json">;
  /** True if this type resolves from the row via resolve-levels; false = special (spawn-location). */
  rowResolved: boolean;
  note: string;
}

/** The registry. Adding a hook type = adding a row here (+ its handler). */
export const HOOK_TYPES: Readonly<Record<string, HookTypeDef>> = {
  "claude-md": {
    type: "claude-md", firesOn: "SessionStart", merge: "sections", formats: ["md"], rowResolved: true,
    note: "layered context injected before turn 1 — identity/constitution/epic/role",
  },
  start: {
    type: "start", firesOn: "SessionStart", merge: "ordered-actions", formats: ["json"], rowResolved: true,
    note: "register/arm + role warm-up (drain inbox, load board, arm resume_command)",
  },
  stop: {
    type: "stop", firesOn: "Stop", merge: "ordered-actions", formats: ["json"], rowResolved: true,
    note: "turn-end reporting: touch, result capture, phase self-report",
  },
  "stop-context": {
    type: "stop-context", firesOn: "Stop", merge: "sections", formats: ["md"], rowResolved: true,
    note: "layered TEXT injected at turn-end (additionalContext) — a role/cluster's per-turn self-check reminder (ADR-0063). The generic replacement for the hardcoded pr-agent phase rubric.",
  },
  "meta-update": {
    type: "meta-update", firesOn: "Stop", merge: "set-union", formats: ["json"], rowResolved: true,
    note: "which ccs metadata fields get refreshed (a set, unioned down the chain)",
  },
  "cmux-paint": {
    type: "cmux-paint", firesOn: "SessionStart", merge: "most-specific", formats: ["json"], rowResolved: true,
    note: "the whole tab + workspace picture — one owner (most-specific level wins). Painted on BOTH SessionStart (first paint) AND Stop (turn-end refresh, so the tab tracks state changes), plus eager-on-resume + `ccs sync-tabs`.",
  },
  statusline: {
    type: "statusline", firesOn: "statusLine", merge: "most-specific", formats: ["json"], rowResolved: true,
    note: "the one status line — one renderer wins",
  },
  "spawn-location": {
    type: "spawn-location", firesOn: "new-session", merge: "most-specific", formats: ["json"], rowResolved: false,
    note: "where a role's session launches — resolves pre-row from the launch request (ADR-0046)",
  },
  spawn: {
    type: "spawn", firesOn: "new-session", merge: "ordered-actions", formats: ["json"], rowResolved: true,
    note: "role-declared BIRTH setup actions run at new-session (ADR-0075): grant-perms, seed-files, … — the deterministic, inspectable replacement for a cluster's bespoke spawn shell script.",
  },
  guard: {
    type: "guard", firesOn: "PreToolUse", merge: "union-deny-wins", formats: ["json"], rowResolved: true,
    note: "per-level tool guards — all matching run, any deny wins (future)",
  },
};

/** Look up a type's declaration, or null for an unknown type (caller decides: lint error / no-op). */
export function hookTypeDef(type: string): HookTypeDef | null {
  return HOOK_TYPES[type] ?? null;
}

/** Every known hook-type name (for `ccs hooks lint` to flag unknown files). */
export function knownHookTypes(): string[] {
  return Object.keys(HOOK_TYPES);
}
