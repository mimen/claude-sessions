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
