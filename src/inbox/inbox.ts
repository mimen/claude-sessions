/**
 * Durable per-identity file inbox (ADR-0023/0033) — the proven event-watch design ported
 * from lib/session_inbox.py.
 *
 * Message content must not depend on cmux keystrokes landing in a busy composer: senders
 * WRITE content to disk (atomic), cmux is only a wake nudge (ADR-0028). Delivery is durable
 * and independent of whether the recipient is running.
 *
 * Protocol: atomic write → move-on-drain (read + move to processed/ in one step) → processed/
 * retained as the audit trail. Idempotent (a moved message is never returned again); the
 * atomic move is also the concurrency guard for a doubled embodiment (ADR-0032). Pure file
 * I/O over a caller-supplied identity directory; no cmux, no catalogue.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SAFE = /[^a-zA-Z0-9_.-]+/g;

export interface InboxMessage {
  /** final path (under processed/ after a drain) */
  path: string;
  sender: string;
  body: string;
}

function safe(s: string): string {
  const cleaned = s.trim().replace(SAFE, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function inboxDir(identityDir: string): string {
  return join(identityDir, "inbox");
}

/** Atomically write one inbox message; returns its path. Disambiguates same-stamp/sender. */
/** Sentinel header line carrying the sender, so it survives even though the stamp in the
 * filename contains dashes (an ISO stamp with dashes makes filename-parsing the sender
 * ambiguous — the stamp tail can leak into it). The header is authoritative; the filename
 * is only for chronological sort + uniqueness. */
const FROM_HEADER = /^<!--\s*ccs-from:\s*(.*?)\s*-->\s*\n?/;

export function writeMessage(
  identityDir: string,
  sender: string,
  body: string,
  stamp: string,
): string {
  const root = inboxDir(identityDir);
  mkdirSync(root, { recursive: true });
  const base = `${safe(stamp)}-${safe(sender)}`;
  let path = join(root, `${base}.md`);
  let n = 2;
  while (existsSync(path)) {
    path = join(root, `${base}-${n}.md`);
    n++;
  }
  const tmp = path + ".tmp";
  // Store the sender in a sentinel header (authoritative on drain), then the body.
  writeFileSync(tmp, `<!-- ccs-from: ${sender} -->\n${body.replace(/\s+$/, "")}\n`);
  renameSync(tmp, path); // atomic — a reader never sees a half-written message
  return path;
}

/** Sort key for a message filename: (base, disambiguator index). Chronological by stamp. */
function sortKey(name: string): [string, number] {
  const stem = name.replace(/\.md$/, "");
  const m = stem.match(/^(.*)-(\d+)$/);
  if (m) return [m[1]!, parseInt(m[2]!, 10)];
  return [stem, 1];
}

/** Pending message paths, oldest first. Empty/missing inbox → []. */
export function pendingMessages(identityDir: string): string[] {
  const root = inboxDir(identityDir);
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => {
      const [ba, ia] = sortKey(a);
      const [bb, ib] = sortKey(b);
      return ba < bb ? -1 : ba > bb ? 1 : ia - ib;
    })
    .map((f) => join(root, f));
}

/**
 * Read pending messages AND move them to inbox/processed/ in one step (move-on-drain).
 * Idempotent: a moved message is never returned again; processed/ is retained as the audit
 * trail. Returns the drained messages (bodies in hand) in chronological order.
 */
export function drain(identityDir: string): InboxMessage[] {
  const root = inboxDir(identityDir);
  const processed = join(root, "processed");
  const out: InboxMessage[] = [];
  for (const path of pendingMessages(identityDir)) {
    const raw = readFileSync(path, "utf8");
    const name = path.split("/").pop()!;
    // Sender: the sentinel header is authoritative; fall back to the legacy filename parse for
    // messages written before the header existed (stamp-tail leak notwithstanding — best effort).
    const m = raw.match(FROM_HEADER);
    const body = m ? raw.slice(m[0].length) : raw;
    const stem = name.replace(/\.md$/, "");
    const sender = m ? m[1]! : stem.includes("-") ? stem.split("-").slice(1).join("-") : "unknown";
    mkdirSync(processed, { recursive: true });
    let dest = join(processed, name);
    let n = 2;
    while (existsSync(dest)) {
      dest = join(processed, `${stem}-${n}.md`);
      n++;
    }
    renameSync(path, dest); // atomically claims + archives the message
    out.push({ path: dest, sender, body });
  }
  return out;
}
