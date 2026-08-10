import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * A bounded read of how a session ENDED.
 *
 * `src/transcript.ts` reads from the head and stops, which is right for a viewer opening a file
 * but wrong here: enrichment's whole question is "where did this land, and what's still open",
 * and that lives in the last turns. So this streams the whole file and keeps a ring buffer of the
 * most recent messages, then trims to a character budget from the end.
 *
 * The head of the session is not lost — the caller pairs this with the index's stored skeleton,
 * which already carries the first turns. Together they give the model the shape of the session
 * (what it set out to do) plus its tail (what actually happened) without shipping a whole
 * transcript into the context window.
 *
 * On a long session those two windows leave a hole, and the hole is most of the session: at 488
 * messages the model saw turns 1-8 and 429-488 and nothing else, so it titled the whole thing
 * after the row-width tweak it happened to stop on. `arc` closes that: user prompts sampled
 * across exactly the stretch the tail drops. Prompts, not assistant prose, because the human
 * turns are the spine of what a session is ABOUT and they cost a fraction of the characters.
 */

interface AnyLine {
  type?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

type Block = { type?: string; text?: string; name?: string; input?: unknown };

const DEFAULT_MAX_MESSAGES = 60;
const DEFAULT_MAX_CHARS = 24_000;

/**
 * The arc's budget: enough entries to show a session changing subject, few enough that it stays a
 * spine rather than a second transcript. 24 x 200 caps it near 5k characters against the tail's
 * 24k, which is deliberate — the arc exists to be BREADTH, and letting it rival the tail in bulk
 * would just move the recency problem rather than fix it.
 */
const MAX_ARC_ENTRIES = 24;
const ARC_ENTRY_CHARS = 200;

/** Flatten one message to a single prose-forward line, with tool calls reduced to stubs. */
function renderMessage(role: string, content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Block;
    if (block.type === "text" && block.text?.trim()) {
      parts.push(block.text.trim());
    } else if (block.type === "tool_use") {
      // Tool NAMES carry real signal about what the session was doing (editing, searching,
      // shelling out); tool bodies are mostly noise and would swamp the budget.
      parts.push(`→ ${block.name ?? "tool"}`);
    }
    // tool_result and thinking blocks are dropped: results are usually large and mechanical,
    // and thinking is not a statement of what the session did.
  }
  return parts.join(" ").trim();
}

export interface TranscriptTail {
  readonly text: string;
  /** True when messages were dropped from the front — the caller says so in the prompt. */
  readonly truncated: boolean;
  /**
   * User prompts sampled across the stretch the tail dropped, each tagged with how far into the
   * session it sits. Empty string when the tail already covers the whole transcript, which is the
   * common case and the reason this is not simply "the first N prompts".
   */
  readonly arc: string;
}

/** One retained user prompt, with the message ordinal that places it in the session. */
interface ArcEntry {
  readonly at: number;
  readonly text: string;
}

/**
 * Pick `max` entries spread evenly across `entries`, endpoints included.
 *
 * Even spacing rather than "the first N": a session's subject changes in the middle, and the first
 * 24 prompts of a 400-message session are all still the opening topic — which is the failure this
 * whole block exists to fix, just at the other end.
 */
function sampleEvenly<T>(entries: readonly T[], max: number): T[] {
  if (entries.length <= max) return [...entries];
  const picked: T[] = [];
  for (let i = 0; i < max; i++) {
    picked.push(entries[Math.round((i * (entries.length - 1)) / (max - 1))]!);
  }
  return picked;
}

/**
 * Read the last `maxMessages` non-sidechain user/assistant messages, capped at `maxChars`, plus
 * an arc over everything before them.
 *
 * Sidechain messages (subagent runs nested inside this file) are skipped: they are a different
 * body of work, they are enriched separately when they are top-level, and including them makes
 * the tail read as if the session were doing something it delegated away.
 *
 * The arc is built in this same pass rather than a second read of the file. It is free here — the
 * stream already visits every line — and a separate reader would be one more thing to keep in
 * step with the sidechain and rendering rules above.
 */
export async function readTranscriptTail(
  path: string,
  maxMessages = DEFAULT_MAX_MESSAGES,
  maxChars = DEFAULT_MAX_CHARS,
): Promise<TranscriptTail> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const recent: string[] = [];
  const userTurns: ArcEntry[] = [];
  let total = 0;
  let dropped = 0;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let obj: AnyLine;
      try {
        obj = JSON.parse(line) as AnyLine;
      } catch {
        continue;
      }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      if (obj.isSidechain) continue;
      const rendered = renderMessage(obj.type, obj.message?.content);
      if (!rendered) continue;
      if (obj.type === "user") {
        // Truncated at collection, not at render: a session can hold thousands of prompts and one
        // of them can be a pasted handoff document, so the memory this holds has to be bounded by
        // the budget it will actually be printed at.
        userTurns.push({ at: total, text: rendered.replace(/\s+/g, " ").slice(0, ARC_ENTRY_CHARS) });
      }
      total++;
      recent.push(`${obj.type === "user" ? "user" : "assistant"}: ${rendered}`);
      if (recent.length > maxMessages) {
        recent.shift();
        dropped++;
      }
    }
  } finally {
    rl.close();
  }

  let text = recent.join("\n\n");
  let truncated = dropped > 0;
  if (text.length > maxChars) {
    // Trim from the FRONT: the end of the transcript is the part that matters.
    text = text.slice(text.length - maxChars);
    truncated = true;
  }

  // Only prompts the tail does NOT already carry. Overlapping the two would spend the arc's budget
  // re-stating the most recent turns, which are the ones already over-represented.
  const retainedFrom = total - recent.length;
  const earlier = userTurns.filter((turn) => turn.at < retainedFrom);
  const arc = sampleEvenly(earlier, MAX_ARC_ENTRIES)
    .map((turn) => `[${Math.round((turn.at / Math.max(total, 1)) * 100)}%] ${turn.text}`)
    .join("\n");

  return { text, truncated, arc };
}
