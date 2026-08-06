/**
 * An exact message count for a session the index has not caught up with.
 *
 * The index is a cache refreshed by `ccs reindex` on a timer, so between runs its `msg_count` is
 * behind by however much the session typed -- measured on a live store, up to 52 messages inside
 * one refresh window. Every reader that compares an enrichment's stamped count against it is
 * therefore comparing against a number from the past, which is how a summary written 73 turns ago
 * came to be labelled current.
 *
 * The fix is available because the index stores `file_size` alongside `msg_count`: both describe
 * the same parse, so the bytes past that offset are exactly the messages the index has not seen.
 * Reading only those bytes costs what the session has typed recently rather than what it has ever
 * typed -- measured at 8 KB and well under a millisecond for a 123 MB transcript, against 302 ms
 * to parse the same file whole.
 *
 * This module is deliberately the only place that knows the trick. Callers ask for a count and get
 * either an exact one or null; whether it came from the index alone, from the index plus a tail, or
 * from nowhere is not their problem.
 */
import { statSync } from "node:fs";

/**
 * What the index recorded about a transcript the last time it parsed it.
 *
 * Every field is optional and nullable, named exactly as the index row names it, so a caller hands
 * over the row it already has. All three are columns an older index may not carry, and a reader
 * that had to check for them itself would be a reader that could get the check wrong.
 */
export interface IndexedTranscript {
  readonly transcriptPath?: string | null;
  /** `msg_count` as of that parse. */
  readonly messageCount?: number | null;
  /** `file_size` as of that same parse -- the offset the count is true at. */
  readonly indexedBytes?: number | null;
}

/**
 * Messages in the appended bytes.
 *
 * Only `user` and `assistant` lines count, because that is what `parse.ts` counts; anything else
 * would produce a number that cannot be compared against the index's own. Unparseable lines are
 * skipped for the same reason the parser skips them -- the last line of a live transcript is
 * routinely half-written, and treating a torn line as a message would overcount by one on exactly
 * the sessions being watched most closely.
 */
function countMessages(tail: string): number {
  let messages = 0;
  for (const line of tail.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { type?: unknown };
      if (parsed.type === "user" || parsed.type === "assistant") messages += 1;
    } catch {
      // A torn final line, or a line this build does not understand. Neither is a message.
    }
  }
  return messages;
}

/**
 * The session's message count right now, or null when it cannot be established.
 *
 * Null rather than a guess, and specifically rather than the index's stale count dressed up as
 * current: the caller's fallback (comparing transcript mtime against the enrichment timestamp) is
 * vaguer but honest, and a confident wrong number is what this whole path exists to prevent.
 */
export async function exactMessageCount(indexed: IndexedTranscript): Promise<number | null> {
  const { transcriptPath, messageCount, indexedBytes } = indexed;
  if (messageCount === null || messageCount === undefined) return null;
  // Without the byte offset the count is true at, there is no way to know which bytes are new.
  // An index predating `file_size` lands here and keeps today's behaviour.
  if (transcriptPath === null || transcriptPath === undefined) return null;
  if (indexedBytes === null || indexedBytes === undefined) return null;

  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    // The transcript moved or was removed since the index saw it; its count is unknowable.
    return null;
  }

  // Caught up: the index parsed every byte that exists, so its count is already exact.
  if (size === indexedBytes) return messageCount;
  // Shorter than when the index looked, so the file was truncated, rotated, or replaced. The
  // stored count describes bytes that are gone and cannot be repaired by reading a tail.
  if (size < indexedBytes) return null;

  try {
    const tail = await Bun.file(transcriptPath).slice(indexedBytes, size).text();
    return messageCount + countMessages(tail);
  } catch {
    return null;
  }
}
