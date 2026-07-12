/**
 * The meta-update field catalogue (ADR-0044): meta-update is a FRESHNESS CONTRACT, not an
 * auto-writer. A level's `meta-update.json` declares which fields should be kept fresh for a
 * session; the VALUES come from each field's own deterministic writer (a sensor, a reflected
 * artifact, or the timestamp itself) — never from the agent "remembering" to update it (that
 * fragility is exactly what config-driven state replaced, cf. the statusline decision).
 *
 * This table encodes "who provides each field" as data, so:
 *  - `ccs hooks lint` can flag a declared field that isn't a known, writable field (a typo that
 *    would otherwise be a silently-dead contract), and
 *  - `ccs hooks explain` can show each declared field's source + current value + freshness.
 *
 * The one field a Stop hook writes itself is `updated_at` (the heartbeat); everything else is
 * reflected by its writer.
 */

/** Where a meta-update field's value comes from (the answer to "who keeps it fresh"). */
export type FieldSource =
  | "timestamp" // the hook computes it (updated_at)
  | "sensor" // an external sensor writes it (git/GitHub → pr_state; W→epic resolution → epic_id)
  | "artifact" // reflected from an agent-produced artifact (worker result.json → phase/result)
  | "agent"; // genuinely agent-only, no sensor/artifact — injected as a best-effort reminder

export interface MetaField {
  field: string;
  source: FieldSource;
  /** True if backed by a catalogue COLUMN (readable via the row); false = identity-state doc. */
  column: boolean;
  note: string;
}

/** The known meta-update fields. Adding a field means declaring its writer here. */
export const META_FIELDS: Readonly<Record<string, MetaField>> = {
  updated_at: { field: "updated_at", source: "timestamp", column: true, note: "the heartbeat — the Stop hook stamps it" },
  stage: { field: "stage", source: "sensor", column: true, note: "pr-agent pipeline stage (catalogue_sync); worker declares milad-review via `ccs stage . milad-review`" },
  activity: { field: "activity", source: "artifact", column: true, note: "within-stage activity; worker self-reports needs-you, engine senses fixing" },
  pr_state: { field: "pr_state", source: "sensor", column: true, note: "git/GitHub sense (catalogue_sync)" },
  pr_number: { field: "pr_number", source: "sensor", column: true, note: "git sense at spawn / catalogue_sync" },
  pr_repo: { field: "pr_repo", source: "sensor", column: true, note: "git sense at spawn / catalogue_sync" },
  pr_head_sha: { field: "pr_head_sha", source: "sensor", column: true, note: "git sense (HEAD of the PR branch)" },
  gus_work: { field: "gus_work", source: "sensor", column: true, note: "orchestrator W→session binding" },
  epic_id: { field: "epic_id", source: "sensor", column: true, note: "W→epic resolution (catalogue_sync)" },
  result: { field: "result", source: "artifact", column: false, note: "worker's result.json (identity-state doc)" },
  judgment: { field: "judgment", source: "artifact", column: false, note: "gate/eval judgment doc (identity-state)" },
};

export function metaField(field: string): MetaField | null {
  return META_FIELDS[field] ?? null;
}

/** Split a declared field list into known + unknown (for lint / explain). */
export function classifyFields(fields: string[]): { known: MetaField[]; unknown: string[] } {
  const known: MetaField[] = [];
  const unknown: string[] = [];
  for (const f of fields) {
    const m = metaField(f);
    if (m) known.push(m);
    else unknown.push(f);
  }
  return { known, unknown };
}
