import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createUsageAccumulator, type CostLine, type UsageTotals } from "./cost.ts";

/** Metadata extracted from a Session transcript by a single streaming pass. */
export interface ParsedSession {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly gitBranch: string | null;
  readonly version: string | null;
  readonly firstTs: string | null;
  readonly lastTs: string | null;
  readonly msgCount: number;
  /** Native Claude Code `ai-title`, if the transcript has one (last one wins). */
  readonly nativeTitle: string | null;
  /** First few raw human user texts, in order — input to label cleaning. */
  readonly userTexts: readonly string[];
  /** Bounded skeleton (first + last turns, tool I/O stubbed) for titling and search. */
  readonly skeleton: string;
  /** True when every message is a sidechain — i.e. this file is a subagent task run. */
  readonly isSubagent: boolean;
  /** For a subagent run, the parent Session's id (subagent files carry the parent's
   *  sessionId internally); null for normal sessions. */
  readonly parentSessionId: string | null;
  /** The id `claude --resume` expects: the session's INTERNAL sessionId, which differs from
   *  the filename for resumed/forked sessions. Falls back to the filename id if absent. */
  readonly resumeId: string;
  /** Billed token totals + API-equivalent cost, summed from the transcript's usage fields. */
  readonly usage: UsageTotals;
}

const FIRST_TURNS = 8;
const LAST_TURNS = 4;
const USER_TEXTS = 4;
const SKELETON_MAX_CHARS = 14_000; // ~3.5k tokens

interface AnyLine extends CostLine {
  type?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  aiTitle?: string;
  isSidechain?: boolean;
  sessionId?: string;
  message?: CostLine["message"] & { role?: string; content?: unknown };
}

type Block = { type?: string; text?: string; name?: string };

/** Concatenated human-authored text of a message (text blocks / string content only). */
function humanText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Block => typeof b === "object" && b !== null)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!.trim())
    .join("\n")
    .trim();
}

/** One skeleton line for a message: prose kept, tool calls/results/thinking reduced to stubs. */
function skeletonLine(role: string, content: unknown): string {
  if (typeof content === "string") return `${role}: ${content.trim()}`;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const b = raw as Block;
    switch (b.type) {
      case "text":
        if (b.text?.trim()) parts.push(b.text.trim());
        break;
      case "tool_use":
        parts.push(`[tool: ${b.name ?? "?"}]`);
        break;
      case "tool_result":
        parts.push("[tool result]");
        break;
      // thinking and others are omitted from the skeleton
    }
  }
  return parts.length ? `${role}: ${parts.join(" ")}` : "";
}

/**
 * Parse one Session file in a single streaming pass with bounded memory — we never hold the
 * whole transcript (files reach 66 MB). Corrupt lines are skipped, never fatal.
 */
export async function parseSessionFile(
  path: string,
  sessionId: string,
): Promise<ParsedSession> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let version: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let nativeTitle: string | null = null;
  let internalSessionId: string | null = null;
  let msgCount = 0;
  let sidechainCount = 0;
  const usage = createUsageAccumulator();

  const userTexts: string[] = [];
  const firstTurns: string[] = [];
  const lastTurns: string[] = []; // rolling buffer, capped to LAST_TURNS

  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: AnyLine;
    try {
      obj = JSON.parse(line) as AnyLine;
    } catch {
      continue; // tolerate partial/corrupt lines
    }

    if (internalSessionId === null && typeof obj.sessionId === "string") {
      internalSessionId = obj.sessionId;
    }
    if (cwd === null && typeof obj.cwd === "string") cwd = obj.cwd;
    if (gitBranch === null && typeof obj.gitBranch === "string") gitBranch = obj.gitBranch;
    if (version === null && typeof obj.version === "string") version = obj.version;
    if (typeof obj.timestamp === "string") {
      firstTs ??= obj.timestamp;
      lastTs = obj.timestamp;
    }
    if (obj.type === "ai-title" && typeof obj.aiTitle === "string") {
      nativeTitle = obj.aiTitle;
      continue;
    }

    if (obj.type === "user" || obj.type === "assistant") {
      msgCount++;
      if (obj.isSidechain) sidechainCount++;
      if (obj.type === "assistant") usage.add(obj);
      const content = obj.message?.content;

      if (obj.type === "user" && userTexts.length < USER_TEXTS) {
        const text = humanText(content);
        if (text) userTexts.push(text);
      }

      const skel = skeletonLine(obj.type, content);
      if (skel) {
        if (firstTurns.length < FIRST_TURNS) firstTurns.push(skel);
        lastTurns.push(skel);
        if (lastTurns.length > LAST_TURNS) lastTurns.shift();
      }
    }
  }

  // A run is a subagent only if it has messages and all of them are sidechain.
  const isSubagent = msgCount > 0 && sidechainCount === msgCount;

  return {
    sessionId,
    cwd,
    gitBranch,
    version,
    firstTs,
    lastTs,
    msgCount,
    nativeTitle,
    userTexts,
    skeleton: buildSkeletonText(firstTurns, lastTurns),
    isSubagent,
    // Only subagent files carry a *parent's* sessionId internally. (Resumed/forked NORMAL
    // sessions also have internal != filename, so we key on isSubagent, not on the mismatch.)
    parentSessionId: isSubagent && internalSessionId ? internalSessionId : null,
    // claude --resume matches the internal sessionId; the filename id fails for resumed/forked
    // sessions. Subagents aren't resumable, so their resumeId (= parent id) is never used.
    resumeId: (!isSubagent && internalSessionId) || sessionId,
    usage: usage.totals(),
  };
}

/** Join first + last turns into a capped skeleton, avoiding overlap on short sessions. */
function buildSkeletonText(firstTurns: string[], lastTurns: string[]): string {
  const seen = new Set(firstTurns);
  const tail = lastTurns.filter((t) => !seen.has(t));
  const joined = [...firstTurns, ...(tail.length ? ["…", ...tail] : [])].join("\n");
  return joined.length > SKELETON_MAX_CHARS ? joined.slice(0, SKELETON_MAX_CHARS) : joined;
}
