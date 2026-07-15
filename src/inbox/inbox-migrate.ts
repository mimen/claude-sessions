import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ccsRuntimeRoot } from "./identity-path.ts";
import { deriveIdentityKey } from "../catalogue/db.ts";
import { sendMessage } from "./inbox-db.ts";

/**
 * ADR-0089 step 5: one-time migration of filesystem inboxes into the `inboxes` table.
 *
 * Filesystem layout (pre-refactor):
 *   ~/.ccs/clusters/<cluster>/identities/<role>/[<epic>/]<work-unit>/inbox/*.md
 *   ~/.ccs/roles/<role>/identities/<role>/inbox/*.md         (standalone core)
 *
 * The migration walks each identity dir, computes its identity_key from the path segments,
 * reads each pending .md message (skipping processed/ audit trail), and INSERTs it into
 * the inboxes table. After a successful migration, the inbox directory is renamed to
 * inbox.migrated so the operator can verify + rm manually.
 *
 * Idempotent: a re-run finds the inbox dir already renamed and skips.
 */

/** Sentinel header written by inbox.ts's writeMessage. */
const FROM_HEADER = /^<!--\s*ccs-from:\s*(.*?)\s*-->\s*\n?/;

/** Read one file inbox's pending messages, oldest first. */
function readFileInboxMessages(inboxDir: string): Array<{ path: string; sender: string; body: string; stamp: string }> {
  if (!existsSync(inboxDir)) return [];
  const files = readdirSync(inboxDir)
    .filter((f) => f.endsWith(".md"))
    .sort(); // filenames start with an ISO stamp so alphabetical == chronological
  const out: Array<{ path: string; sender: string; body: string; stamp: string }> = [];
  for (const name of files) {
    const path = join(inboxDir, name);
    if (!statSync(path).isFile()) continue;
    const raw = readFileSync(path, "utf8");
    const m = raw.match(FROM_HEADER);
    const body = m ? raw.slice(m[0].length) : raw;
    const sender = m ? m[1]! : "unknown";
    // Filename shape: <stamp>-<sender>.md ; use the stamp portion for created_at ordering.
    const stem = name.replace(/\.md$/, "");
    const stampMatch = stem.match(/^([0-9]{8}T[0-9]{6}Z)/);
    const stamp = stampMatch ? isoifyStamp(stampMatch[1]!) : new Date().toISOString();
    out.push({ path, sender, body, stamp });
  }
  return out;
}

/** Convert 20260714T120000Z → 2026-07-14T12:00:00Z (readable ISO). */
function isoifyStamp(s: string): string {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return new Date().toISOString();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

interface WalkedInbox {
  identityKey: string;
  inboxDir: string;
}

/**
 * Walk each cluster's identities tree and return each identity's inbox dir with its derived
 * identity_key. Also handles the standalone ~/.ccs/roles/&lt;role&gt;/identities/&lt;role&gt;/ layout.
 */
function findFileInboxes(runtimeRoot: string): WalkedInbox[] {
  const out: WalkedInbox[] = [];
  const clustersRoot = join(runtimeRoot, "clusters");
  if (existsSync(clustersRoot)) {
    for (const cluster of readdirSync(clustersRoot)) {
      const clusterPath = join(clustersRoot, cluster);
      if (!statSync(clusterPath).isDirectory()) continue;
      const identitiesRoot = join(clusterPath, "identities");
      if (!existsSync(identitiesRoot)) continue;
      for (const role of readdirSync(identitiesRoot)) {
        const rolePath = join(identitiesRoot, role);
        if (!statSync(rolePath).isDirectory()) continue;
        walkFleetIdentities(rolePath, cluster, role, [], out);
      }
    }
  }
  const rolesRoot = join(runtimeRoot, "roles");
  if (existsSync(rolesRoot)) {
    for (const role of readdirSync(rolesRoot)) {
      const rolePath = join(rolesRoot, role);
      if (!statSync(rolePath).isDirectory()) continue;
      // Standalone: <root>/roles/<role>/identities/<role>/inbox/
      const standalonePath = join(rolePath, "identities", role);
      if (existsSync(join(standalonePath, "inbox"))) {
        // Standalone identity_key uses "standalone" as the cluster placeholder — best effort.
        const key = deriveIdentityKey({ cluster: "standalone", role });
        if (key) out.push({ identityKey: key, inboxDir: join(standalonePath, "inbox") });
      }
    }
  }
  return out;
}

/** Recursively descend a fleet role's identity tree (epic/work-unit segments). */
function walkFleetIdentities(
  currentPath: string,
  cluster: string,
  role: string,
  segments: string[],
  out: WalkedInbox[],
): void {
  // If this dir has an inbox subdirectory, treat it as an identity.
  if (existsSync(join(currentPath, "inbox"))) {
    const workUnit = segments[segments.length - 1] ?? null;
    // Legacy paths use flat keys like "owner_repo-12345"; the new identity key wants a PR-shaped
    // ref. Best-effort: try to reconstitute from a "flat" key of the form <owner>_<repo>-<num>.
    const workRef = workUnit ? reconstitutePrRef(workUnit) : null;
    const key = workRef
      ? deriveIdentityKey({ cluster, role, prRepo: workRef.repo, prNumber: workRef.num })
      : deriveIdentityKey({ cluster, role });
    if (key) out.push({ identityKey: key, inboxDir: join(currentPath, "inbox") });
  }
  // Descend into subdirectories (epic/work-unit tiers), skipping inbox/ itself.
  for (const entry of readdirSync(currentPath)) {
    if (entry === "inbox") continue;
    const child = join(currentPath, entry);
    if (!statSync(child).isDirectory()) continue;
    walkFleetIdentities(child, cluster, role, [...segments, entry], out);
  }
}

/** Turn "owner_repo-12345" back into { repo: "owner/repo", num: 12345 }. */
function reconstitutePrRef(flat: string): { repo: string; num: number } | null {
  const m = flat.match(/^([a-z0-9._-]+)_([a-z0-9._-]+)-(\d+)$/i);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, num: parseInt(m[3]!, 10) };
}

/** Migrate every file inbox into the DB. Returns the number of messages migrated. */
export function migrateFileInboxesToDb(db: Database, runtimeRoot = ccsRuntimeRoot()): number {
  let migrated = 0;
  for (const { identityKey, inboxDir } of findFileInboxes(runtimeRoot)) {
    const messages = readFileInboxMessages(inboxDir);
    for (const m of messages) {
      sendMessage(db, identityKey, m.body, m.sender, m.stamp);
      migrated++;
    }
    // Rename the dir (never delete) so a re-run doesn't re-migrate.
    if (messages.length > 0 || existsSync(inboxDir)) {
      try {
        renameSync(inboxDir, `${inboxDir}.migrated`);
      } catch {
        // Leave in place if we can't rename; migration is idempotent enough (a re-run
        // sees the .md files again and re-sends, causing duplicates — worth living with
        // if this rare permission error hits).
      }
    }
  }
  return migrated;
}
