import { hostname } from "node:os";
import { MERGE_PATH } from "../paths.ts";
import { openMerge, ownerOf } from "./merge.ts";

/**
 * Host-owned rows (issue 33): a Host writes only its own sessions' catalogue rows. "Foreign"
 * is what the Merged View says — no merged view (not built/pulled yet) or an unreadable one
 * means no verdict, and the write proceeds locally (pre-33 behavior; the merge's owner-primacy
 * rule shadows rather than corrupts a stray local write). Advisory-until-known,
 * enforced-once-known.
 *
 * Host identity is ONE namespace: replicate.py keys replica dirs by `scutil --get
 * LocalHostName`, so ownership comparisons use the same source — NOT config host.label (the
 * Index's session-origin tag, which defaults to os.hostname() and can be a DHCP name like
 * `Mac.attlocal.net`).
 */

let cachedHostName: string | null = null;

/** This Host's name as the fleet knows it (replica dir key). Cached per process. */
export function localHostName(): string {
  if (cachedHostName) return cachedHostName;
  try {
    const proc = Bun.spawnSync(["scutil", "--get", "LocalHostName"], { stdout: "pipe", stderr: "ignore" });
    const name = new TextDecoder().decode(proc.stdout).trim();
    if (proc.exitCode === 0 && name) return (cachedHostName = name);
  } catch {
    // non-macOS or scutil missing — fall through
  }
  return (cachedHostName = hostname().split(".")[0]!);
}

/** The one Host-name comparison (case-insensitive) — never hand-roll this elsewhere. */
export function sameHost(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The FOREIGN owner of a session, or null when the row is ours / unknown to the merged view /
 * no readable merged view. A non-null return means: don't write locally, send an edit intent.
 */
export function foreignOwner(
  sessionId: string,
  mergePath: string = MERGE_PATH,
  localHost: string = localHostName(),
): string | null {
  let db;
  try {
    db = openMerge(mergePath);
    if (!db) return null;
    const owner = ownerOf(db, sessionId);
    if (!owner) return null;
    return sameHost(owner, localHost) ? null : owner;
  } catch (e) {
    // A corrupt/half-pulled merge.db must not brick every local write — it's a rebuildable
    // view. No verdict, but say why so the user knows ownership checks are offline.
    console.error(
      `ccs: merged view unreadable (${(e as Error).message}) — ownership checks skipped; ` +
        `rebuild with \`ccs merge\` / \`ccs merge --pull\` or delete ${mergePath}`,
    );
    return null;
  } finally {
    db?.close();
  }
}

/** The standard refusal message — every write verb points at the same door. */
export function foreignWriteError(sessionId: string, owner: string): string {
  return (
    `${sessionId.slice(0, 8)}… is ${owner}'s row (Host-owned; merged view). ` +
    `Send an edit intent instead: ccs intent ${sessionId} <op> <value>`
  );
}
