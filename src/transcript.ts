import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** A rendered transcript line with a kind, for coloring in the viewer. */
export interface TranscriptLine {
  readonly kind: "user" | "assistant" | "tool" | "meta";
  readonly text: string;
}

interface AnyLine {
  type?: string;
  message?: { role?: string; content?: unknown };
}

type Block = { type?: string; text?: string; name?: string; input?: unknown };

/** Flatten a message's content into rendered transcript lines (prose kept, tools stubbed fuller). */
function renderMessage(role: "user" | "assistant", content: unknown): TranscriptLine[] {
  if (typeof content === "string") {
    const t = content.trim();
    return t ? [{ kind: role, text: t }] : [];
  }
  if (!Array.isArray(content)) return [];
  const lines: TranscriptLine[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Block;
    switch (b.type) {
      case "text":
        if (b.text?.trim()) lines.push({ kind: role, text: b.text.trim() });
        break;
      case "tool_use": {
        const arg = summarizeInput(b.input);
        lines.push({ kind: "tool", text: `→ ${b.name ?? "tool"}${arg ? ` ${arg}` : ""}` });
        break;
      }
      case "tool_result":
        lines.push({ kind: "tool", text: "← tool result" });
        break;
      // thinking is skipped
    }
  }
  return lines;
}

/** A short one-line hint of a tool call's input (e.g. a command or file path). */
function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  const key = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url;
  if (typeof key !== "string") return "";
  const flat = key.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? flat.slice(0, 99) + "…" : flat;
}

/**
 * Read a Session transcript into rendered lines, streamed and bounded. Reads at most
 * `maxMessages` user/assistant messages (skipping tool-noise-only and sidechain churn is left
 * to the viewer); returns lines plus whether the transcript was truncated.
 */
export async function readTranscript(
  path: string,
  maxMessages = 400,
): Promise<{ lines: TranscriptLine[]; truncated: boolean }> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const lines: TranscriptLine[] = [];
  let messages = 0;
  let truncated = false;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: AnyLine;
    try {
      obj = JSON.parse(line) as AnyLine;
    } catch {
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (messages >= maxMessages) {
      truncated = true;
      break;
    }
    const rendered = renderMessage(obj.type, obj.message?.content);
    if (rendered.length) {
      lines.push(...rendered);
      lines.push({ kind: "meta", text: "" }); // blank separator between turns
      messages++;
    }
  }
  rl.close();
  return { lines, truncated };
}
