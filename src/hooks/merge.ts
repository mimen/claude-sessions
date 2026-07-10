import type { MergeKind } from "./hook-types.ts";

/**
 * The per-type merge combinators (ADR-0044): fold the ordered layers (broad → specific) into
 * one effective config, by the strategy the hook type declares. Pure functions — the primary
 * test seam for the whole layered-hook system (ADR-0045).
 *
 * A "layer" is one level's parsed config (already read from disk by the caller); layers arrive
 * in resolve order (user → cluster → role → epic → work-unit → identity). A layer that was
 * absent is simply not in the array.
 */

// ── claude-md: ordered sections by id ───────────────────────────────────────────
// A claude-md layer is a list of sections; each section has an id, body, an op (how it combines
// with an inherited section of the same id), and an optional `floor` flag (a broad level marking
// a section non-suppressable — a floor section can only be appended to by lower levels).

export type SectionOp = "append" | "replace" | "suppress";
export interface Section {
  id: string;
  body: string;
  /** How this section combines with an inherited same-id section. Default "append". */
  op?: SectionOp;
  /** Floor sections (set by a broad level) can't be replaced/suppressed by a lower level. */
  floor?: boolean;
}
/** A claude-md layer as produced by parseMd / a JSON claude-md file: `{ sections: [...] }`. */
export interface ClaudeMdLayer { sections: Section[] }

/**
 * Merge claude-md section layers. Sections are keyed by id; final order = first-seen order
 * (a broad level introduces the id, lower levels modify in place). Floor protection:
 * once a section is floor, a lower level's replace/suppress is DOWNGRADED to append (the
 * invariant survives; the lower level's text is still added). ADR-0044.
 */
export function mergeSections(layers: ClaudeMdLayer[]): Section[] {
  const order: string[] = [];
  const byId = new Map<string, Section>();
  for (const layer of layers) {
    for (const s of layer.sections ?? []) {
      const prev = byId.get(s.id);
      if (!prev) {
        order.push(s.id);
        byId.set(s.id, { ...s, op: undefined });
        continue;
      }
      const op: SectionOp = prev.floor && s.op && s.op !== "append" ? "append" : (s.op ?? "append");
      if (op === "suppress") {
        byId.set(s.id, { ...prev, body: "" }); // suppressed: keep id present but empty
      } else if (op === "replace") {
        byId.set(s.id, { ...prev, body: s.body, floor: prev.floor || s.floor });
      } else {
        // append: concatenate bodies (skip empties so a suppressed-then-appended reads clean)
        const joined = [prev.body, s.body].filter((b) => b.length > 0).join("\n\n");
        byId.set(s.id, { ...prev, body: joined, floor: prev.floor || s.floor });
      }
    }
  }
  return order.map((id) => byId.get(id)!).filter((s) => s.body.length > 0 || s.floor);
}

/** Render merged sections to the injected context string (## heading per section). */
export function renderSections(sections: Section[]): string {
  return sections.filter((s) => s.body.length > 0).map((s) => `## ${s.id}\n${s.body}`).join("\n\n");
}

// ── meta-update: set-union of field names ────────────────────────────────────────

export interface FieldsLayer { fields: string[] }

/** Union the field-name sets down the chain, preserving first-seen order (ADR-0044). */
export function mergeSetUnion(layers: FieldsLayer[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of layers) for (const f of l.fields ?? []) {
    if (!seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out;
}

// ── start/stop: ordered action lists ─────────────────────────────────────────────

export interface Action { name: string; order?: number; [k: string]: unknown }
export interface ActionsLayer { actions: Action[] }

/**
 * Append all layers' actions, then sort by explicit `order` (default 100), stable within equal
 * order (broad-level actions run before same-order specific ones). De-dupe by name — a lower
 * level re-declaring an action name replaces the earlier one in place (keeps its slot). ADR-0044.
 */
export function mergeOrderedActions(layers: ActionsLayer[]): Action[] {
  const byName = new Map<string, Action>();
  const firstSeen: string[] = [];
  for (const l of layers) for (const a of l.actions ?? []) {
    if (!byName.has(a.name)) firstSeen.push(a.name);
    byName.set(a.name, a); // later (more specific) declaration wins for that name
  }
  const items = firstSeen.map((n) => byName.get(n)!);
  return items
    .map((a, i) => ({ a, i, order: a.order ?? 100 }))
    .sort((x, y) => x.order - y.order || x.i - y.i)
    .map((x) => x.a);
}

// ── most-specific-wins ───────────────────────────────────────────────────────────

/** Return the last (most-specific) non-null layer, or null if none contributed. ADR-0044. */
export function pickMostSpecific<T>(layers: Array<T | null | undefined>): T | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const v = layers[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

// ── guard: union with deny-wins ──────────────────────────────────────────────────

export interface GuardRule { pattern: string; decision: "allow" | "deny" }
export interface GuardLayer { rules: GuardRule[] }

/** Union all rules; on a pattern present as both allow and deny anywhere, deny wins. ADR-0044. */
export function mergeGuards(layers: GuardLayer[]): GuardRule[] {
  const decision = new Map<string, "allow" | "deny">();
  const order: string[] = [];
  for (const l of layers) for (const r of l.rules ?? []) {
    if (!decision.has(r.pattern)) order.push(r.pattern);
    // deny is sticky: once denied, stays denied regardless of a later allow.
    if (decision.get(r.pattern) === "deny") continue;
    decision.set(r.pattern, r.decision);
  }
  return order.map((pattern) => ({ pattern, decision: decision.get(pattern)! }));
}

/** Dispatch by declared merge kind — the seam the pipeline calls. Returns the effective config
 * shape for that kind (caller knows the concrete type from the hook type). */
export function mergeByKind(kind: MergeKind, layers: unknown[]): unknown {
  switch (kind) {
    case "sections": return mergeSections(layers as ClaudeMdLayer[]);
    case "set-union": return mergeSetUnion(layers as FieldsLayer[]);
    case "ordered-actions": return mergeOrderedActions(layers as ActionsLayer[]);
    case "most-specific": return pickMostSpecific(layers as Array<unknown | null>);
    case "union-deny-wins": return mergeGuards(layers as GuardLayer[]);
  }
}
