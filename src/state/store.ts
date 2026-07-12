/**
 * ccs durable-state store (ADR-0031) — the file-backed, versioned, atomic JSON layer that
 * all identity + cluster state sits on. The inbox is the first consumer of this pattern;
 * this generalizes it into a store any system can use through ccs.
 *
 * Guarantees:
 *  - atomic write (temp + rename): a reader never sees a half-written file
 *  - every doc carries schemaVersion + updatedAt + source (so readers can render staleness
 *    and refuse unknown versions instead of best-guessing)
 *  - a missing file is not an error (absence = "nothing yet")
 *  - a corrupt / unknown-version file is quarantined and treated as absent, never poisons reads
 *  - mergeFields = single-writer-per-field (ADR-0004/0031): touch only the given keys
 *
 * Pure file I/O over caller-supplied paths; the path resolvers (identity-path.ts) decide
 * WHERE, this decides HOW.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { log } from "../logger.ts";

/** Bump when the envelope shape changes. Unknown (future) versions are refused on read. */
export const SCHEMA_VERSION = 1;

export interface StateDoc<T = unknown> {
  schemaVersion: number;
  updatedAt: string;
  /** who wrote it last (a role/system name) — for staleness display + single-writer audit */
  source: string;
  data: T;
}

export interface WriteOpts {
  now: string;
  source: string;
}

/** Atomically write `data` wrapped in the standard envelope. Creates parent dirs. */
export function writeDoc<T>(path: string, data: T, opts: WriteOpts): void {
  mkdirSync(dirname(path), { recursive: true });
  const doc: StateDoc<T> = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: opts.now,
    source: opts.source,
    data,
  };
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  renameSync(tmp, path); // atomic — reader sees old or new, never partial
}

/**
 * Read a document. Returns null for a missing file (absence is fine), and QUARANTINES a
 * corrupt or unknown-version file (moves it to <path>.corrupt.<stamp>) so it can't poison
 * future reads, then returns null.
 */
export function readDoc<T = unknown>(path: string): StateDoc<T> | null {
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    log.error("Failed to read state document", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    log.error("Corrupt state document, quarantining", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    quarantine(path);
    return null;
  }
  const doc = parsed as StateDoc<T>;
  if (
    !doc ||
    typeof doc !== "object" ||
    typeof doc.schemaVersion !== "number" ||
    doc.schemaVersion > SCHEMA_VERSION // future/unknown -> refuse, don't misread
  ) {
    log.error("Invalid or future-version state document, quarantining", {
      path,
      schemaVersion: doc?.schemaVersion,
      expected: SCHEMA_VERSION,
    });
    quarantine(path);
    return null;
  }
  return doc;
}

/**
 * Update only the given top-level fields of a doc's `data` object, leaving the rest intact
 * (single-writer-per-field, ADR-0004/0031). Creates the file if absent.
 */
export function mergeFields(
  path: string,
  fields: Record<string, unknown>,
  opts: WriteOpts,
): void {
  const existing = readDoc<Record<string, unknown>>(path);
  const merged = { ...(existing?.data ?? {}), ...fields };
  writeDoc(path, merged, opts);
}

/** Move a bad file aside so it stops poisoning reads. Best-effort. */
function quarantine(path: string): void {
  try {
    // no Date.now in some contexts; use a monotonic-ish suffix from the file's own mtime
    const suffix = `${Date.now()}`;
    renameSync(path, `${path}.corrupt.${suffix}`);
  } catch {
    /* if we can't move it, leave it; read still returns null */
  }
}
