/**
 * ADR-D2 + B11: versioned zod schema for `board.json`. Cluster composers write JSON; we can't
 * trust that they always match the tool's TypeScript types. Validate on read so a malformed row
 * from a second, less-dogfooded composer fails at the BOUNDARY (with a useful message), not
 * deep in `buildMaps()` or the TUI paint code with a cryptic "cannot read property of undefined".
 *
 * The schema is a superset — extra fields (like `today`, `sprints`, cluster-private `data`
 * blobs, the legacy `prs[]` compatibility field, `senseHealth`, `ticketedNoPr`, etc.) are
 * PRESERVED via `passthrough()`. Only the fields the tool actively reads are validated.
 *
 * Version: the emitted board carries a schema version (`schemaVersion`, default 1) so a
 * future breaking change can be gated at the boundary. Clusters that don't emit it default to
 * v1 for compatibility.
 */
import { z } from "zod";

export const BOARD_SCHEMA_VERSION = 1;

const PillSchema = z.object({
  key: z.string(),
  label: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  priority: z.number().optional(),
}).passthrough();

const AlertSchema = z.object({
  name: z.string(),
  severity: z.union([z.literal("hard"), z.literal("soft")]),
  reason: z.string(),
  owner: z.string(),
  sinceTick: z.number().nullable().optional(),
}).passthrough();

const RowSessionSchema = z.object({
  sessionId: z.string(),
  isPrimary: z.boolean(),
  lastActivity: z.string().nullable(),
}).passthrough();

const BoardRowSchema = z.object({
  identity: z.string(),
  workUnit: z.object({ kind: z.string() }).passthrough(),
  sessions: z.array(RowSessionSchema),
  pills: z.array(PillSchema),
  description: z.string().nullable(),
  alerts: z.array(AlertSchema),
  awaitingFrom: z.array(z.string()),
  lastComposed: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const BoardSchema = z.object({
  status: z.union([z.literal("OK"), z.literal("DEGRADED"), z.literal("FAILED")]).optional(),
  provenance: z.object({
    source: z.string(),
    command: z.string().optional(),
    at: z.string(),
  }).passthrough().optional(),
  rows: z.array(BoardRowSchema),
  // schemaVersion is authored by the composer; defaults to 1 for clusters that don't emit it.
  schemaVersion: z.number().optional(),
}).passthrough();

export type ValidatedBoard = z.infer<typeof BoardSchema>;

/**
 * Parse + validate raw board.json content. Returns { ok: true, value } on success, or
 * { ok: false, error } with a prettified error message. Never throws — callers handle
 * the error case explicitly.
 */
export function parseBoard(raw: string): { ok: true; value: ValidatedBoard } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `board.json is not valid JSON: ${(e as Error).message}` };
  }
  // Unwrap the ADR-0031 state envelope if present.
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if ("schemaVersion" in obj && "data" in obj && obj.data && typeof obj.data === "object") {
      parsed = obj.data;
    }
  }
  const result = BoardSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `board.json failed schema validation:\n${z.prettifyError(result.error)}` };
  }
  return { ok: true, value: result.data };
}
