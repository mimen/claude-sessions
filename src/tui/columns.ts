/**
 * Shared column widths for the list + its header row, so the two never drift. Numeric columns
 * are right-aligned; the model column is left-aligned text. Left gutter = caret(1) + glyph(2).
 */
export const CARET_W = 1;
export const GLYPH_W = 2;
/** Status column (lifecycle × live open-state) — e.g. active/idle/parked/done. */
export const STATUS_W = 8;
/** Stage column (per-system worker pipeline stage) — building/milad-review/in-review/approved/merged. */
export const PHASE_W = 10;
/** Role column (catalogue.skill, abbreviated) — e.g. control/concierge/eval/worker. */
export const ROLE_W = 10;
/** Claude task-list column (▣ done/total, ! when interrupted) — wide terminals only. */
export const TASKS_W = 8;
export const MODEL_W = 7;
export const COST_W = 7;
export const AGE_W = 5;
/** Last column: subagent count (↳N) in list views, or subtree cost (Σ$1.9k) in the tree view. */
export const SUB_W = 6;
/** Right margin between the flexible title/event region and the fixed right cluster. */
export const TITLE_MR = 1;
