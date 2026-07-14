import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { type Result, ok, err } from "../result.ts";
import { ccsConfigRoot } from "../roles/role-files.ts";

/**
 * The cluster manifest (`cluster.toml`) — the tool's typed view of a cluster package (ADR-0048/0058).
 *
 * A cluster is a self-contained package: role definitions, an executable engine, and this manifest.
 * Until ADR-0058 the tool NEVER read cluster.toml — the engine paths were only used by the cluster's
 * own scripts, and nothing declared a version contract between the layers (ADR-0041's three homes).
 * That is exactly how the engine sensors silently skewed from the tool's catalogue schema: no layer
 * declared "I need ccs ≥ X", so a tool-side migration could desync the engine with no loud failure.
 *
 * This module establishes decision-part 2 of ADR-0058: the manifest declares its own `version`
 * (monotonic, independent of ccs semver) and `requires_ccs` (a semver range), and the tool GATES on
 * load — refuse on a major-version gap, warn on a minor one. The per-cluster CHANGELOG + the
 * `catch-up` start action build on top of this parsed manifest.
 */

/** A parsed semver triple (major.minor.patch). Mirrors CmuxVersion in cmux/live.ts. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Parse "X.Y.Z" (leading `v`/`=`/whitespace tolerated) into a SemVer, or null if it doesn't match. */
export function parseSemVer(s: string): SemVer | null {
  const match = s.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match || !match[1] || !match[2] || !match[3]) return null;
  return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), patch: parseInt(match[3], 10) };
}

/** -1 / 0 / +1 for a<b / a==b / a>b, comparing major then minor then patch. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * A `requires_ccs` constraint. Only the `>=X.Y.Z` form is supported (the ADR's example) — a lower
 * bound is what a config package actually needs ("I depend on at least this tool"). An unrecognized
 * string parses to null and the gate treats it as "unconstrained but malformed" (warns, never blocks).
 */
export interface CcsRequirement {
  min: SemVer;
}

/** Parse `>=X.Y.Z` (spaces optional). Returns null for any other shape. */
export function parseCcsRequirement(s: string): CcsRequirement | null {
  const m = s.trim().match(/^>=\s*(.+)$/);
  if (!m || !m[1]) return null;
  const min = parseSemVer(m[1]);
  return min ? { min } : null;
}

const ManifestSchema = z.object({
  name: z.string(),
  engine: z.string().optional(),
  sense: z.string().optional(),
  board: z.string().optional(),
  /** ADVISORY / legacy only. The authoritative cluster version is the highest entry in the cluster
   * CHANGELOG (see changelog.ts) — deriving it there means "add the next-numbered entry" is the one
   * authoring action, with no second number to keep in sync. Parsed for tolerance, never gated on. */
  version: z.union([z.string(), z.number()]).optional(),
  /** Semver range the cluster depends on, e.g. ">=0.1.0". Optional (legacy clusters lack it). */
  requires_ccs: z.string().optional(),
  /** ADR-0070: the cluster's mid-level GROUPING TYPE (pr-watch = "epic"). A display label + a
   * sensing/render hint, NOT storage — the grouping entity stays generic (ADR-0051/0059). */
  grouping_type: z.string().optional(),
});

/** The typed cluster manifest, as the tool sees it. Absolute `engineDir`/`sensePath`/`boardPath` are resolved. */
export interface ClusterManifest {
  name: string;
  /** Absolute path to the engine dir, or null when the package declares none. */
  engineDir: string | null;
  /** Absolute path to the sense entry, or null. */
  sensePath: string | null;
  /** Absolute path to the board composer, or null. */
  boardPath: string | null;
  /** Advisory/legacy manifest `version` if present (normalized to a string), else null. NOT the
   * authoritative cluster version — that's the highest CHANGELOG entry. Kept only for tolerance. */
  version: string | null;
  /** The raw `requires_ccs` string as authored, or null. */
  requiresCcs: string | null;
  /** The cluster's declared grouping type (ADR-0070), e.g. "epic". A label + sensing/render hint;
   * defaults to "epic" when undeclared (the historical assumption), never null so callers can
   * always show a word. The generic grouping entity is unchanged — this only types the label. */
  groupingType: string;
}

/**
 * Read + parse a cluster's `cluster.toml`. Returns err() when the file is missing or malformed —
 * a cluster with no readable manifest is a real problem the caller should surface, not paper over
 * (unlike role.toml, which is fail-open because most fields are directory-derived).
 */
export function readClusterManifest(cluster: string, configRoot = ccsConfigRoot()): Result<ClusterManifest> {
  const dir = join(configRoot, "clusters", cluster);
  const tomlPath = join(dir, "cluster.toml");
  if (!existsSync(tomlPath)) {
    return err(new Error(`cluster "${cluster}" has no cluster.toml at ${tomlPath}`));
  }
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(tomlPath, "utf8"));
  } catch (e) {
    return err(new Error(`malformed cluster.toml for "${cluster}": ${(e as Error).message}`));
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err(new Error(`invalid cluster.toml for "${cluster}":\n${z.prettifyError(parsed.error)}`));
  }
  const m = parsed.data;
  return ok({
    name: m.name,
    engineDir: m.engine ? join(dir, m.engine) : null,
    sensePath: m.sense ? join(dir, m.sense) : null,
    boardPath: m.board ? join(dir, m.board) : null,
    version: m.version === undefined ? null : String(m.version),
    requiresCcs: m.requires_ccs ?? null,
    groupingType: m.grouping_type ?? "epic",
  });
}

/** The outcome of gating a cluster's ccs requirement against the running tool version. */
export type GateVerdict =
  | { status: "ok" }
  | { status: "warn"; message: string }
  | { status: "refuse"; message: string };

/**
 * Gate a cluster's `requires_ccs` against the running ccs version (ADR-0058: refuse on a major gap,
 * warn on a minor one). A cluster with no requirement, or a malformed one, never blocks — it can at
 * most warn, so an in-flight fleet keeps rolling while the operator fixes the manifest.
 *
 *   - no requirement declared            → ok (legacy cluster, unconstrained)
 *   - malformed requirement string       → warn (can't enforce; surface it)
 *   - running < required, same major      → warn (minor/patch gap: probably fine, flag it)
 *   - running < required, MAJOR gap       → refuse (the config contract may have changed)
 *   - running >= required                 → ok
 */
export function gateCcsRequirement(m: ClusterManifest, ccs: SemVer): GateVerdict {
  if (!m.requiresCcs) return { status: "ok" };
  const req = parseCcsRequirement(m.requiresCcs);
  if (!req) {
    return {
      status: "warn",
      message: `cluster "${m.name}" declares an unrecognized requires_ccs "${m.requiresCcs}" (expected ">=X.Y.Z") — not enforced`,
    };
  }
  if (compareSemVer(ccs, req.min) >= 0) return { status: "ok" };
  const gap = `cluster "${m.name}" needs ccs ${m.requiresCcs}, but this is ${ccs.major}.${ccs.minor}.${ccs.patch}`;
  // A major-version shortfall means the documented config contract may have changed under the
  // cluster — refuse. A minor/patch shortfall is most often bug fixes that don't touch the
  // contract — warn and let it run (the ADR's "refuse on major gap, warn on minor").
  if (ccs.major < req.min.major) return { status: "refuse", message: `${gap} (major-version gap — refusing)` };
  return { status: "warn", message: `${gap} (minor gap — proceeding)` };
}

/**
 * Combined read + gate for a cluster, at the point the tool brings it online. A missing/malformed
 * manifest is surfaced as a warn (the manifest is advisory for legacy clusters, so a bad one flags
 * but never blocks a resume); a readable manifest is gated per gateCcsRequirement. `ccsVersionStr`
 * is the running tool's version (package.json). Pure + injectable via configRoot for testing.
 */
export function checkClusterGate(cluster: string, ccsVersionStr: string, configRoot = ccsConfigRoot()): GateVerdict {
  const ccs = parseSemVer(ccsVersionStr);
  if (!ccs) return { status: "warn", message: `could not parse running ccs version "${ccsVersionStr}" — cluster gate skipped` };
  const res = readClusterManifest(cluster, configRoot);
  if (!res.ok) return { status: "warn", message: res.error.message };
  return gateCcsRequirement(res.value, ccs);
}
