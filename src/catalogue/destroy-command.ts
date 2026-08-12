/**
 * `ccs session destroy` and `ccs session incognito` — the CLI surface over destroy.ts.
 *
 * Destroy follows the preflight convention used elsewhere in ccs (bare invocation inspects, a flag
 * mutates), but tightens it in one way that matters: the flag is `--confirm <session-id>`, and the
 * id must be typed out in full. A bare `--yes` would be a single token an agent can append to the
 * command it just printed, which is exactly the mistake this gate exists to catch. Retyping the id
 * is a second, independent act of naming what dies.
 */
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { openCatalogue } from "./db-schema.ts";
import { getRow } from "./db-queries.ts";
import { sessionById } from "../index/index.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH, ensureDataDir } from "../paths.ts";
import {
  buildManifest,
  executeDestroy,
  markIncognito,
  productionEnvironment,
  survivingSurfaces,
  type DestroyEnvironment,
  type DestroyManifest,
} from "./destroy.ts";

/**
 * Programmatic entry points for callers that must not open the catalogue themselves.
 *
 * The sidebar is the reason these exist. ADR-0068 keeps database handles out of the request layer
 * -- `src/sidebar/**` may hold no writer -- so the sidebar calls these and this module owns the
 * handle, exactly as `commands.ts` does for the lifecycle verbs.
 */
export interface CatalogueDestroyOptions {
  readonly cataloguePath?: string;
  readonly indexPath?: string;
  readonly now?: () => Date;
  readonly ensureDataDir?: () => void;
  readonly environment?: DestroyEnvironment;
}

interface DestroyContext {
  readonly cataloguePath: string;
  readonly indexPath: string;
  readonly nowIso: string;
  readonly environment: DestroyEnvironment;
}

function destroyContext(options: CatalogueDestroyOptions): DestroyContext {
  (options.ensureDataDir ?? ensureDataDir)();
  return {
    cataloguePath: options.cataloguePath ?? CATALOGUE_PATH(),
    indexPath: options.indexPath ?? DB_PATH(),
    nowIso: (options.now ?? (() => new Date()))().toISOString(),
    environment: options.environment ?? productionEnvironment(),
  };
}

export type MarkIncognitoOutcome =
  | { readonly status: "ok"; readonly incognito: boolean }
  | { readonly status: "catalogue-unreadable"; readonly reason: string };

/** Mark or unmark, creating the catalogue row if the session has never been catalogued. */
export function markSessionIncognito(
  sessionId: string,
  incognito: boolean,
  options: CatalogueDestroyOptions = {},
): MarkIncognitoOutcome {
  const context = destroyContext(options);
  let catalogue: Database | null = null;
  try {
    catalogue = openCatalogue(context.cataloguePath);
    markIncognito(catalogue, sessionId, incognito, context.nowIso);
    return { status: "ok", incognito };
  } catch (error) {
    return {
      status: "catalogue-unreadable",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    catalogue?.close();
  }
}

export interface DestroyFigures {
  readonly sessionCount: number;
  readonly pathCount: number;
  readonly liveCount: number;
  readonly survivingIdentities: readonly string[];
}

export type DestroyPreflightResult =
  | ({ readonly status: "ok" } & DestroyFigures)
  | { readonly status: "not-found" }
  | { readonly status: "failed"; readonly reason: string };

export type DestroyResult =
  | { readonly status: "destroyed"; readonly sessionIds: readonly string[]; readonly filesRemoved: number }
  | { readonly status: "aborted"; readonly reason: string }
  | { readonly status: "not-found" }
  | { readonly status: "failed"; readonly reason: string };

function pathsIn(manifest: DestroyManifest): number {
  return manifest.footprints.reduce(
    (total, footprint) =>
      total + footprint.transcripts.length + footprint.files.length + footprint.directories.length,
    0,
  );
}

/** What a destroy would remove. Reads only. */
export async function previewDestroy(
  sessionId: string,
  options: CatalogueDestroyOptions = {},
): Promise<DestroyPreflightResult> {
  const context = destroyContext(options);
  let catalogue: Database | null = null;
  let index: Database | null = null;
  try {
    catalogue = openCatalogue(context.cataloguePath);
    index = existsSync(context.indexPath) ? openIndex(context.indexPath) : null;
    const manifest = await buildManifest(catalogue, index, sessionId, context.environment);
    const pathCount = pathsIn(manifest);
    if (pathCount === 0 && getRow(catalogue, sessionId) === null) return { status: "not-found" };
    return {
      status: "ok",
      sessionCount: manifest.footprints.length,
      pathCount,
      liveCount: manifest.liveSessionIds.length,
      survivingIdentities: manifest.survivingIdentities,
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    index?.close();
    catalogue?.close();
  }
}

/**
 * Execute a destroy.
 *
 * The manifest is rebuilt here rather than accepted from the caller. A caller-supplied manifest
 * would be a list of paths to delete arriving from outside, and the seconds between a reader
 * confirming and this running are long enough for a session to go live.
 */
export async function destroySessionTree(
  sessionId: string,
  options: CatalogueDestroyOptions = {},
): Promise<DestroyResult> {
  const context = destroyContext(options);
  let catalogue: Database | null = null;
  let index: Database | null = null;
  try {
    catalogue = openCatalogue(context.cataloguePath);
    index = existsSync(context.indexPath) ? openIndex(context.indexPath) : null;
    const manifest = await buildManifest(catalogue, index, sessionId, context.environment);
    if (pathsIn(manifest) === 0 && getRow(catalogue, sessionId) === null) {
      return { status: "not-found" };
    }
    const outcome = await executeDestroy(catalogue, index, manifest, context.environment, context.nowIso);
    if (!outcome.ok) return { status: "aborted", reason: outcome.error.message };
    return {
      status: "destroyed",
      sessionIds: outcome.value.destroyed,
      filesRemoved: outcome.value.filesRemoved,
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    index?.close();
    catalogue?.close();
  }
}

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Resolve `.` to the running session, mirroring the rest of `ccs session`. */
function resolveSessionId(token: string | undefined): string | null {
  if (!token) return null;
  if (token !== ".") return token;
  return process.env.CLAUDE_CODE_SESSION_ID ?? null;
}

function openIndexIfPresent(): Database | null {
  return existsSync(DB_PATH()) ? openIndex(DB_PATH()) : null;
}

function printManifest(sessionId: string, manifest: DestroyManifest, env: DestroyEnvironment): void {
  const fileCount = manifest.footprints.reduce(
    (total, f) => total + f.transcripts.length + f.files.length + f.directories.length,
    0,
  );
  console.log(`ccs session destroy ${sessionId} — DRY RUN, nothing has been deleted.`);
  console.log("");
  console.log(`${manifest.footprints.length} session(s), ${fileCount} path(s) on disk:`);
  for (const footprint of manifest.footprints) {
    const marker = footprint.sessionId === sessionId ? "" : "  (descendant)";
    console.log(`  ${footprint.sessionId}${marker}${footprint.live ? "  [LIVE — will be closed first]" : ""}`);
    for (const path of footprint.transcripts) console.log(`    transcript  ${path}`);
    for (const dir of footprint.directories) console.log(`    directory   ${dir}`);
    for (const file of footprint.files) console.log(`    file        ${file}`);
  }
  if (manifest.survivingIdentities.length > 0) {
    console.log("");
    console.log("Identities are NOT destroyed (they outlive their sessions and may be shared):");
    for (const key of manifest.survivingIdentities) console.log(`  ${key}`);
  }
  console.log("");
  console.log("These are not touched, and may still mention the session:");
  for (const path of survivingSurfaces(env)) console.log(`  ${path}`);
  console.log("");
  console.log("This cannot be undone. To proceed, retype the id:");
  console.log(`  ccs session destroy ${sessionId} --confirm ${sessionId}`);
}

export async function destroyCommand(
  args: readonly string[],
  env: DestroyEnvironment = productionEnvironment(),
): Promise<number> {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const confirmIndex = args.indexOf("--confirm");
  const confirmValue = confirmIndex === -1 ? null : args[confirmIndex + 1] ?? "";

  const sessionId = resolveSessionId(positional[0]);
  if (!sessionId) {
    console.error("usage: ccs session destroy <id|.> [--confirm <id>]");
    console.error("       bare invocation prints the manifest; --confirm <id> executes it");
    return 2;
  }

  ensureDataDir();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndexIfPresent();
  try {
    const manifest = await buildManifest(catalogue, index, sessionId, env);
    // A session with no catalogue row and nothing on disk is either already gone or was never real.
    // Saying so is more useful than printing an empty manifest and offering to destroy nothing.
    const empty = manifest.footprints.every(
      (f) => f.transcripts.length === 0 && f.files.length === 0 && f.directories.length === 0,
    );
    if (empty && !getRow(catalogue, sessionId)) {
      console.error(`ccs session destroy: nothing found for '${sessionId}'`);
      return 1;
    }

    if (confirmIndex === -1) {
      printManifest(sessionId, manifest, env);
      return 0;
    }
    // The mismatch case is the whole point of the gate, so it reports what was expected rather
    // than re-printing the manifest, which would invite pasting the wrong id a second time.
    if (confirmValue !== sessionId) {
      console.error(
        `ccs session destroy: --confirm must repeat the session id exactly (expected '${sessionId}', got '${confirmValue}')`,
      );
      return 2;
    }

    const outcome = await executeDestroy(catalogue, index, manifest, env, now());
    if (!outcome.ok) {
      console.error(`ccs session destroy: ${outcome.error.message}`);
      return 1;
    }
    const { destroyed, filesRemoved, rowsRemoved, detachedChildren } = outcome.value;
    const rows = Object.entries(rowsRemoved)
      .filter(([, count]) => count > 0)
      .map(([table, count]) => `${table}=${count}`)
      .join(" ");
    console.log(
      `destroyed ${destroyed.length} session(s), ${filesRemoved} path(s) removed${rows ? `, rows: ${rows}` : ""}` +
        (detachedChildren > 0 ? `, ${detachedChildren} surviving child row(s) detached` : ""),
    );
    return 0;
  } finally {
    index?.close();
    catalogue.close();
  }
}

export function incognitoCommand(args: readonly string[]): number {
  const off = args.includes("--off");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  // Defaulting to the running session is deliberate: the common case is realizing mid-conversation
  // that this one should not have been visible, and the id is the thing you do not have to hand.
  const sessionId = resolveSessionId(positional[0] ?? ".");
  if (!sessionId) {
    console.error("usage: ccs session incognito [<id>|.] [--off]");
    console.error("       with no id, marks the running session (CLAUDE_CODE_SESSION_ID)");
    return 2;
  }

  ensureDataDir();
  const catalogue = openCatalogue(CATALOGUE_PATH());
  const index = openIndexIfPresent();
  try {
    // Deliberately not gated on an existing catalogue row. `setIncognito` creates one, and the
    // session most likely to need hiding is an ad-hoc `claude` run that was never born through
    // ccs, or one whose transcript has not been indexed yet. Refusing those would fail exactly
    // the case the feature exists for. A typo'd id costs one inert row; a refusal costs the
    // guarantee.
    const known = getRow(catalogue, sessionId) !== null
      || (index !== null && sessionById(index, sessionId) !== null);
    markIncognito(catalogue, sessionId, !off, now());
    if (!known) {
      console.warn(
        `ccs session incognito: '${sessionId}' is not yet known to ccs (no catalogue row, not indexed). ` +
          "The mark is recorded and applies as soon as it is — check the id if that is a surprise.",
      );
    }
    if (off) {
      console.log(`${sessionId} is no longer incognito; it will reappear in listings.`);
      // Enrichment is cleared on the way in and not restored on the way out. Saying so keeps the
      // operator from reading an empty summary as a bug.
      console.log("Its stored summary was cleared when it was marked and does not come back.");
    } else {
      console.log(`${sessionId} is incognito: hidden from listings, excluded from enrichment,`);
      console.log("and never composed into another session's context. Undo with --off.");
    }
    return 0;
  } finally {
    index?.close();
    catalogue.close();
  }
}
