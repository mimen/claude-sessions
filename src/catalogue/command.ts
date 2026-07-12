import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { InferenceEngine } from "../inference/engine.ts";
import {
  setKey,
  setParent,
  setProject,
  setCompleted,
  setArchived,
  setCustomTitle,
  addTag,
  removeTag,
  type Kind,
} from "./db.ts";

/**
 * Natural-language editor for session ORGANIZATION METADATA, backed by an inference engine. The
 * user types an instruction ("mark all glizzy sessions done", "this is a loop backed by
 * ops-watch"); the engine maps it to a set of metadata mutations against a numbered session
 * list; we apply them to the catalogue. It only ever touches metadata
 * (kind/event/skill/parent/lifecycle/title/tags) — never the sessions themselves or the TUI.
 */
export interface SessionMeta {
  readonly sessionId: string;
  readonly title: string;
  readonly kind: Kind;
  readonly key: string | null;
  readonly parentSessionId: string | null;
  readonly completed: boolean;
  readonly archived: boolean;
  /** User-assigned project label (catalogue), if any. */
  readonly project: string | null;
  /** Git repo the session ran in (for context / disambiguation). */
  readonly repo: string;
}

export interface Mutation {
  readonly sessionId: string;
  readonly op: "key" | "event" | "skill" | "parent" | "project" | "completed" | "archived" | "title" | "tag" | "untag";
  /** Resolved value: for `parent`, a target sessionId or null; booleans as "true"/"false". */
  readonly value: string | null;
}

const SCHEMA_PATH = join(import.meta.dir, "command-schema.json");

const PROMPT =
  "You edit ORGANIZATION METADATA for Claude Code sessions in a catalogue. You are given a " +
  "numbered list of sessions with their current metadata, then an INSTRUCTION. Output the minimal " +
  "set of mutations that satisfies the instruction, referencing sessions by their NUMBER from the " +
  "list. Never invent numbers; never change anything not asked for. If a FOCUS number is given, " +
  "the instruction is primarily about that session (but you may reference others by number, e.g. " +
  "for a parent). Ops and their value: event→a slug or 'none'; skill→a " +
  "name or 'none'; project→a project/initiative name (lowercase slug) or 'none'; parent→the " +
  "target session NUMBER or 'none'; completed/archived→'true'|'false'; title→a short custom " +
  "title; tag/untag→an entity name. Respond using the provided JSON schema.";

interface RawMutation {
  n?: number;
  op?: string;
  value?: string | null;
}

/** Build the numbered session context Codex reasons over. */
function renderSessions(sessions: readonly SessionMeta[]): string {
  const titleById = new Map(sessions.map((s, i) => [s.sessionId, i + 1]));
  return sessions
    .map((s, i) => {
      const parent = s.parentSessionId ? `#${titleById.get(s.parentSessionId) ?? "?"}` : "none";
      const flags = [
        `kind=${s.kind}`,
        `key=${s.key ?? "none"}`,
        `project=${s.project ?? "none"}`,
        `parent=${parent}`,
        s.completed ? "done" : "",
        s.archived ? "archived" : "",
        `repo=${s.repo}`,
      ].filter(Boolean);
      return `${i + 1}. ${s.title}  [${flags.join(" ")}]`;
    })
    .join("\n");
}

/** Run the instruction through the engine and return resolved mutations (or an error message). */
export async function runMetadataCommand(
  instruction: string,
  sessions: readonly SessionMeta[],
  focusSessionId: string | null,
  engine: InferenceEngine,
  timeoutMs = 90_000,
): Promise<{ mutations: Mutation[] } | { error: string }> {
  if (!instruction.trim()) return { mutations: [] };
  const focusN = focusSessionId ? sessions.findIndex((s) => s.sessionId === focusSessionId) + 1 : 0;
  const stdin =
    `INSTRUCTION: ${instruction.trim()}\n` +
    (focusN > 0 ? `FOCUS: #${focusN}\n` : "") +
    `\nSESSIONS:\n${renderSessions(sessions)}\n`;

  try {
    const parsed = (await engine.runStructured({
      prompt: PROMPT,
      stdin,
      schemaPath: SCHEMA_PATH,
      timeoutMs,
    })) as { mutations?: RawMutation[] } | null;
    if (!parsed) return { error: `${engine.name} failed` };
    const raw = Array.isArray(parsed.mutations) ? parsed.mutations : [];
    const mutations: Mutation[] = [];
    for (const m of raw) {
      const idx = typeof m.n === "number" ? m.n - 1 : -1;
      const subject = sessions[idx];
      if (!subject || !m.op) continue;
      const v = m.value == null ? null : String(m.value).trim();
      const cleared = v === null || /^(none|null|clear|)$/i.test(v);
      let value: string | null;
      switch (m.op) {
        case "parent": {
          // value is a target NUMBER referencing another session.
          const t = v && /^#?\d+$/.test(v) ? sessions[Number(v.replace("#", "")) - 1] : null;
          value = cleared ? null : t?.sessionId ?? null;
          break;
        }
        case "key":
        case "event":
        case "skill":
        case "title":
        case "project":
          value = cleared ? null : v;
          break;
        case "completed":
        case "archived":
          value = /^(true|yes|1|done)$/i.test(v ?? "") ? "true" : "false";
          break;
        case "tag":
        case "untag":
          if (cleared) continue;
          value = v;
          break;
        default:
          continue;
      }
      mutations.push({ sessionId: subject.sessionId, op: m.op as Mutation["op"], value });
    }
    return { mutations };
  } catch {
    return { error: `${engine.name} error` };
  }
}

/** Apply resolved mutations to the catalogue. Returns a short human summary of what changed. */
export function applyMutations(catalogue: Database, mutations: readonly Mutation[], now: string): string {
  const counts = new Map<string, number>();
  for (const m of mutations) {
    switch (m.op) {
      case "key":
      case "event":
        setKey(catalogue, m.sessionId, m.value, now);
        break;
      case "project":
        setProject(catalogue, m.sessionId, m.value, now);
        break;
      case "parent":
        setParent(catalogue, m.sessionId, m.value, now);
        break;
      case "completed":
        setCompleted(catalogue, m.sessionId, m.value === "true", now);
        break;
      case "archived":
        setArchived(catalogue, m.sessionId, m.value === "true", now);
        break;
      case "title":
        setCustomTitle(catalogue, m.sessionId, m.value, now);
        break;
      case "tag":
        if (m.value) addTag(catalogue, m.sessionId, m.value);
        break;
      case "untag":
        if (m.value) removeTag(catalogue, m.sessionId, m.value);
        break;
    }
    counts.set(m.op, (counts.get(m.op) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([op, n]) => `${n} ${op}`);
  return parts.length ? `${mutations.length} change${mutations.length === 1 ? "" : "s"}: ${parts.join(", ")}` : "no changes";
}
