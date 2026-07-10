import { existsSync, readFileSync } from "node:fs";
import type { CatalogueRow } from "../catalogue/db.ts";
import { hookTypeDef } from "./hook-types.ts";
import { resolveLevels, hookFileBase, type Level, type ResolveCtx } from "./resolve-levels.ts";
import { mergeByKind } from "./merge.ts";

/**
 * The resolve → read → merge pipeline (ADR-0043/0044/0045): given a row and a hook type, produce
 * the EFFECTIVE config by resolving the ordered levels, reading each level's `.ccs-hooks/<type>`
 * file, and folding them with the type's declared combinator.
 *
 * Determinism contract (ADR-0045):
 *  - resolve from the row only (resolve-levels is pure); reads are the only I/O here.
 *  - absent file = the level contributes nothing (no search, no fallback).
 *  - one format per (level, type) slot: a `.md` AND a `.json` for the same slot is an ERROR.
 *  - a present-but-unparseable file fails THAT TYPE for THAT LEVEL closed: it's dropped, the
 *    session is flagged degraded, and the already-valid broader/other layers still apply.
 */

export interface LayerRead {
  level: Level;
  dir: string;
  /** Parsed config for this level (md → {sections}, json → object), or null if absent. */
  config: unknown | null;
  /** A per-level problem (bad format collision / parse error) — surfaced, never silently eaten. */
  error?: string;
}

export interface EffectiveConfig {
  type: string;
  /** The merged result; shape depends on the type's merge kind. Null if the type is unknown. */
  effective: unknown;
  /** Per-level reads, in resolve order (for `ccs hooks explain`). */
  layers: LayerRead[];
  /** True if any layer errored — the session should be marked degraded (ADR-0035). */
  degraded: boolean;
  /** Non-fatal problems, for logging/explain. */
  errors: string[];
}

/** Every extension a hook file could use — collision is detected across ALL of these, not just
 * the type's accepted set, so a stray `foo.md` next to `foo.json` is caught (ADR-0045). */
const ALL_EXTS = ["md", "json"] as const;

/** Read one level's config for a type. Absent → null; collision/wrong-format/parse-fail → {error}. */
function readLayer(dir: string, type: string, formats: ReadonlyArray<"md" | "json">): LayerRead {
  const base = hookFileBase(dir, type);
  const onDisk = ALL_EXTS.filter((ext) => existsSync(`${base}.${ext}`));
  if (onDisk.length === 0) return { level: "user", dir, config: null }; // level filled by caller
  if (onDisk.length > 1) {
    return { level: "user", dir, config: null, error: `multiple formats for ${type} at ${dir} (${onDisk.join(", ")}) — one per slot` };
  }
  const ext = onDisk[0]!;
  if (!formats.includes(ext)) {
    return { level: "user", dir, config: null, error: `${type} does not accept .${ext} at ${dir} (accepts ${formats.join(", ")})` };
  }
  const path = `${base}.${ext}`;
  try {
    const raw = readFileSync(path, "utf8");
    return { level: "user", dir, config: ext === "json" ? JSON.parse(raw) : parseMd(raw) };
  } catch (e) {
    return { level: "user", dir, config: null, error: `unparseable ${path}: ${(e as Error).message}` };
  }
}

/**
 * Parse a claude-md file into sections. Front-matter-free: `## <id>` starts a section; an
 * optional `<!-- ccs:floor -->` or `<!-- ccs:op=replace -->` marker on the line after the heading
 * sets flags. Text before the first heading becomes an implicit "preamble" section.
 */
export function parseMd(raw: string): { sections: Array<{ id: string; body: string; op?: string; floor?: boolean }> } {
  const lines = raw.split("\n");
  const sections: Array<{ id: string; body: string; op?: string; floor?: boolean }> = [];
  let cur: { id: string; body: string[]; op?: string; floor?: boolean } | null = null;
  const flush = () => { if (cur) sections.push({ id: cur.id, body: cur.body.join("\n").trim(), op: cur.op, floor: cur.floor }); };
  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { flush(); cur = { id: h[1]!.trim(), body: [] }; continue; }
    const marker = line.match(/<!--\s*ccs:(.+?)\s*-->/);
    if (marker && cur) {
      for (const kv of marker[1]!.split(/\s+/)) {
        if (kv === "floor") cur.floor = true;
        else if (kv.startsWith("op=")) cur.op = kv.slice(3);
      }
      continue;
    }
    if (!cur) cur = { id: "preamble", body: [] };
    cur.body.push(line);
  }
  flush();
  return { sections: sections.filter((s) => s.body.length > 0 || s.floor) };
}

/** Resolve the effective config for a row + hook type (the pipeline). */
export function resolveConfig(row: CatalogueRow, type: string, ctx: ResolveCtx): EffectiveConfig {
  const def = hookTypeDef(type);
  if (!def) {
    return { type, effective: null, layers: [], degraded: false, errors: [`unknown hook type: ${type}`] };
  }
  const levels = resolveLevels(row, ctx);
  const layers: LayerRead[] = [];
  const errors: string[] = [];
  for (const lvl of levels) {
    const read = readLayer(lvl.dir, type, def.formats);
    read.level = lvl.level; // stamp the true level (readLayer doesn't know it)
    read.dir = lvl.dir;
    if (read.error) errors.push(read.error);
    layers.push(read);
  }
  // Fold only the layers that contributed valid config, in resolve order. A layer with an error
  // contributes null (dropped) — the valid layers still merge (ADR-0045: fail that layer closed).
  const contributing = layers.filter((l) => l.config !== null).map((l) => l.config);
  const effective = def.merge === "most-specific"
    ? mergeByKind(def.merge, layers.map((l) => l.config)) // most-specific needs the null slots for position
    : mergeByKind(def.merge, contributing);
  return { type, effective, layers, degraded: errors.length > 0, errors };
}
