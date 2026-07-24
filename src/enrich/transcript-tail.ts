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
 */

interface AnyLine {
  type?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

type Block = { type?: string; text?: string; name?: string; input?: unknown };

const DEFAULT_MAX_MESSAGES = 60;
const DEFAULT_MAX_CHARS = 24_000;

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
}

/**
 * Read the last `maxMessages` non-sidechain user/assistant messages, capped at `maxChars`.
 *
 * Sidechain messages (subagent runs nested inside this file) are skipped: they are a different
 * body of work, they are enriched separately when they are top-level, and including them makes
 * the tail read as if the session were doing something it delegated away.
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
  return { text, truncated };
}
