/**
 * Turn-end self-check SIDECAR (ADR-0063 v2).
 *
 * A pr-agent worker's Stop hook forks a detached child process that runs THIS module. The
 * sidecar reads the worker's recent transcript, reads its current catalogue state, reads the
 * role-authored `stop-context.md` rubric, and asks a cheap Claude (`claude -p`, model = sonnet)
 * to decide which `ccs` state updates the worker should have made THIS turn. The sidecar then
 * executes those `ccs` commands against the WORKER'S session id — the worker's main-thread
 * turn never sees any of this.
 *
 * Why sidecar and not inline additionalContext:
 *   - Deterministic contract: the Stop hook is a pure side-effect trigger; no coupling to how
 *     the main agent chooses to phrase or omit its response.
 *   - No `stop_hook_active` continuation dance, no zero-output-turn harness retry.
 *   - The self-check reasoning is durable + inspectable (per-session log file), not fleeting
 *     model output smuggled through additionalContext.
 *   - Roles that don't author a `stop-context.md` are still a full no-op (file-presence keyed).
 *
 * Failure mode: any error in the sidecar is logged + swallowed. A missed self-check is fine —
 * the tab just stays as last painted; the next turn's Stop fires the sidecar again.
 */
import { existsSync, mkdirSync, appendFileSync, statSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { openCatalogue, getRow, type CatalogueRow } from "../catalogue/db.ts";
import { CATALOGUE_PATH, DEFAULT_STORE_PATH, runtimeRoot, ensureDataDir } from "../paths.ts";
import { composeStopContext } from "./compose-claude-md.ts";

/** Where the sidecar writes its per-session log. Under the runtime root so it never touches the
 * git-tracked config tree. Rotates on size (best-effort). */
function selfCheckLogPath(sessionId: string): string {
  const dir = join(runtimeRoot(), "self-check");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.log`);
}

/** Where sidecar `claude -p` calls run. A dedicated empty CWD so the resulting `~/.claude/projects`
 * entry pools in one predictable location (easy to gc; can't be confused for real work). */
function sidecarCwd(): string {
  const dir = join(runtimeRoot(), "sidecar-cwd");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Per-session lock: drop-if-running semantics — if a prior sidecar is still working this session,
 * exit. The next Stop will fire another. Cheaper than queueing, and self-corrects. */
function lockPath(sessionId: string): string {
  const dir = join(runtimeRoot(), "self-check", "locks");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.lock`);
}

/** Atomic-create the lock file with wx (fails if exists). Returns true on acquire. Best-effort:
 * a stale lock (crashed sidecar) is cleared if older than STALE_MS. */
const STALE_MS = 10 * 60 * 1000;
function tryAcquireLock(sessionId: string): boolean {
  const p = lockPath(sessionId);
  try {
    if (existsSync(p)) {
      const age = Date.now() - statSync(p).mtimeMs;
      if (age > STALE_MS) {
        try { unlinkSync(p); } catch { /* fall through */ }
      } else {
        return false;
      }
    }
    // wx: exclusive-create; throws EEXIST if lost the race.
    const fd = openSync(p, "wx");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(sessionId: string): void {
  try { unlinkSync(lockPath(sessionId)); } catch { /* fine */ }
}

/** Append a timestamped line to the session's log. Never throws. */
function log(sessionId: string, line: string): void {
  try {
    const ts = new Date().toISOString();
    appendFileSync(selfCheckLogPath(sessionId), `[${ts}] ${line}\n`);
  } catch { /* fail-open */ }
}

/**
 * Find the worker's transcript file: `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`.
 * Cwd isn't stored on the row, so we search across project dirs by filename. Cheap: readdir per
 * top-level project dir. Returns null if not found (session too new / GC'd).
 */
function findTranscript(sessionId: string): string | null {
  const root = DEFAULT_STORE_PATH;
  if (!existsSync(root)) return null;
  const target = `${sessionId}.jsonl`;
  try {
    for (const projectDir of readdirSync(root)) {
      const p = join(root, projectDir, target);
      if (existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return null;
}

/** Read the last N user/assistant messages from a transcript, condensed to a compact string for
 * the sidecar prompt. Reads the whole file (transcripts are bounded, and we only need the tail);
 * keeps the last N. */
async function tailTranscript(path: string, tailMessages = 12): Promise<string> {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    // Walk from the end, collecting user/assistant messages until we have tailMessages.
    const msgs: string[] = [];
    for (let i = lines.length - 1; i >= 0 && msgs.length < tailMessages; i--) {
      const l = lines[i]?.trim();
      if (!l) continue;
      let obj: { type?: string; message?: { role?: string; content?: unknown } };
      try { obj = JSON.parse(l); } catch { continue; }
      if (obj.type !== "user" && obj.type !== "assistant") continue;
      msgs.unshift(formatTailMessage(obj.type, obj.message?.content));
    }
    return msgs.filter((s) => s.length > 0).join("\n\n---\n\n");
  } catch {
    return "";
  }
}

function formatTailMessage(role: "user" | "assistant", content: unknown): string {
  const parts: string[] = [];
  if (typeof content === "string") {
    parts.push(content.trim());
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      if (typeof raw !== "object" || raw === null) continue;
      const b = raw as { type?: string; text?: string; name?: string; input?: unknown };
      if (b.type === "text" && b.text?.trim()) parts.push(b.text.trim());
      else if (b.type === "tool_use") {
        const arg = summarizeInput(b.input);
        parts.push(`[tool: ${b.name ?? "?"}${arg ? ` ${arg}` : ""}]`);
      }
    }
  }
  const body = parts.join("\n").trim();
  if (!body) return "";
  // Cap per-message size so a huge tool_result dump doesn't blow the prompt.
  const capped = body.length > 2000 ? body.slice(0, 2000) + "…[truncated]" : body;
  return `## ${role}\n${capped}`;
}

function summarizeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const o = input as Record<string, unknown>;
  const key = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url ?? o.description;
  if (typeof key !== "string") return "";
  const flat = key.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 119) + "…" : flat;
}

/** A compact JSON view of the row's state the sidecar's model needs to decide updates. Deliberately
 * excludes chatty fields (notes, resume_command) so the prompt stays small. */
function stateSnapshot(row: CatalogueRow): Record<string, unknown> {
  return {
    role: row.role,
    cluster: row.cluster,
    stage: row.stage,
    statusLine: row.statusLine,
    shortname: row.meta?.shortname ?? null,
    prNumber: row.prNumber,
    prRepo: row.prRepo,
    prBranch: row.prBranch,
    prState: row.prState,
    groupingId: row.groupingId,
    gusWork: row.gusWork,
  };
}

/** Build the prompt sent to `claude -p`. The model returns ONLY `ccs` commands (one per line)
 * or `NONE`. No prose. The `--session-id` target is spliced into each command by the caller. */
function buildPrompt(row: CatalogueRow, rubric: string, transcript: string, epicLabel: string | null): string {
  const state = JSON.stringify(stateSnapshot(row), null, 2);
  const epicNote = epicLabel
    ? `\nEpic label (already shown as a pill next to the tab — DO NOT restate this as the shortname): "${epicLabel}"`
    : "";
  return `You are the turn-end SELF-CHECK sidecar for a pr-watch worker session. Your job: based on the worker's recent activity, decide which \`ccs\` state updates it SHOULD have made this turn, and output them.

## Rubric this worker's role has authored

${rubric}

## Current session state${epicNote}

\`\`\`json
${state}
\`\`\`

## Recent transcript (worker's last few messages, oldest first)

${transcript || "(no transcript available)"}

## Your output

Output ONLY \`ccs\` commands, one per line, targeting THIS session (use the placeholder \`{SID}\` in place of a session id — the caller substitutes the real one). Use \`.\`-form is not acceptable; use \`{SID}\`.

Valid command shapes (stage is engine-computed and NOT worker-settable — do NOT emit \`ccs stage\`):
- \`ccs name {SID} "<shortname 28–35 chars>"\`   ← if you're proposing a shortname change and your candidate is under 28 chars, ADD specificity until it's ≥28. Do not emit a shorter one.
- \`ccs status {SID} "<status>"\`
- \`ccs status {SID} --off\`

If the CURRENT shortname is under 28 chars, propose a longer, more specific one.

If no update is warranted, output exactly:
NONE

No prose. No commentary. No headers. No code fences. One command per line, or NONE.`;
}

/** Parse the model's output into a list of `ccs` arg-arrays, substituting {SID}. Drops anything
 * that isn't a recognized `ccs` command shape. Returns [] on `NONE` / empty / all-invalid. */
export function parseCommands(output: string, sessionId: string): string[][] {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0]!.toUpperCase() === "NONE") return [];
  const cmds: string[][] = [];
  for (const line of lines) {
    if (line.toUpperCase() === "NONE") continue;
    // Strip a leading `$ ` or `> ` if the model adds one.
    const clean = line.replace(/^[$>]\s+/, "");
    // Very restrictive: must start with `ccs ` and contain {SID}.
    if (!clean.startsWith("ccs ")) continue;
    if (!clean.includes("{SID}")) continue;
    // Tokenize respecting double-quoted args (shortname/status can contain spaces).
    const tokens = tokenize(clean);
    if (tokens.length < 3) continue;
    if (tokens[0] !== "ccs") continue;
    const sub = tokens.map((t) => t.replaceAll("{SID}", sessionId));
    // Allow only the whitelisted subcommands.
    const sub1 = sub[1];
    if (!ALLOWED_SUBCMDS.has(sub1!)) continue;
    cmds.push(sub);
  }
  return cmds;
}

const ALLOWED_SUBCMDS = new Set(["name", "status"]);

function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    // skip whitespace
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    if (line[i] === '"') {
      i++;
      let buf = "";
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length) { buf += line[i + 1]; i += 2; }
        else { buf += line[i]; i++; }
      }
      i++; // consume closing quote
      out.push(buf);
    } else {
      let buf = "";
      while (i < line.length && !/\s/.test(line[i]!)) { buf += line[i]; i++; }
      if (buf) out.push(buf);
    }
  }
  return out;
}

/** Invoke `claude -p` with the built prompt. Runs from a dedicated sidecar CWD so any resulting
 * `~/.claude/projects` entries pool in one predictable directory. Returns stdout on success. */
async function askClaude(prompt: string, model: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const proc = Bun.spawn(["claude", "-p", "--model", model, prompt], {
      cwd: sidecarCwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [text, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exit = await proc.exited;
    if (exit !== 0) return { ok: false, error: `claude -p exited ${exit}: ${stderr.slice(0, 500)}` };
    return { ok: true, text: text.trim() };
  } catch (e) {
    return { ok: false, error: `spawn claude -p failed: ${(e as Error).message}` };
  }
}

/** Get the human-readable epic label for a row, if any. Best-effort. */
async function epicLabelFor(row: CatalogueRow): Promise<string | null> {
  if (!row.cluster || !row.groupingId) return null;
  try {
    const mod = await import("../state/groupings.ts");
    const g = mod.getGrouping(row.cluster, row.groupingId);
    return g?.label ? String(g.label).replace(/^\[[^\]]+\]\s*/, "").trim() || null : null;
  } catch {
    return null;
  }
}

/** Execute one `ccs …` command as an in-process call (avoids re-spawning bun). Returns the exit
 * code. Wrapped so a bad command can never crash the sidecar. */
async function runCcs(argv: string[]): Promise<number> {
  try {
    // Re-enter the CLI main with a synthetic argv so this counts as a normal `ccs` invocation
    // (permission checks, logging, catalogue writes — all the same). The [0][1] slots stand in for
    // node/script paths that `main` slices off.
    const { main } = await import("../cli.ts");
    return await main(["_bun", "_ccs", ...argv]);
  } catch {
    return -1;
  }
}

export interface SelfCheckOptions {
  /** The worker's session id (target of updates). */
  sessionId: string;
  /** Model name for `claude -p`. Defaults to sonnet; overridable via env for cost tuning. */
  model?: string;
}

/**
 * The sidecar entrypoint. Reads state, builds prompt, calls Claude, runs the resulting ccs
 * commands, logs everything. ALWAYS returns 0 (fail-open). This is `ccs self-check <sid>`.
 */
export async function runSelfCheck(opts: SelfCheckOptions): Promise<number> {
  const { sessionId } = opts;
  const model = opts.model ?? process.env.CCS_SELF_CHECK_MODEL ?? "sonnet";
  if (!tryAcquireLock(sessionId)) {
    log(sessionId, "skip: another sidecar is running for this session");
    return 0;
  }
  try {
    ensureDataDir();
    const db = openCatalogue(CATALOGUE_PATH());
    let row: CatalogueRow | null = null;
    try { row = getRow(db, sessionId); } finally { db.close(); }
    if (!row || !row.role) {
      log(sessionId, "skip: not a registered/rooted session");
      return 0;
    }
    const rubric = composeStopContext(row);
    if (!rubric) {
      log(sessionId, "skip: role authored no stop-context rubric");
      return 0;
    }
    const transcriptPath = findTranscript(sessionId);
    const transcript = transcriptPath ? await tailTranscript(transcriptPath) : "";
    log(sessionId, `start (model=${model}, transcript=${transcriptPath ? "found" : "missing"})`);

    const prompt = buildPrompt(row, rubric, transcript, await epicLabelFor(row));
    // For durability + debugging: dump the exact prompt to disk (small, transient).
    try {
      writeFileSync(join(runtimeRoot(), "self-check", `${sessionId}.last-prompt.md`), prompt);
    } catch { /* fail-open */ }

    const res = await askClaude(prompt, model);
    if (!res.ok) {
      log(sessionId, `claude error: ${res.error}`);
      return 0;
    }
    log(sessionId, `raw response: ${res.text.replace(/\n/g, " | ").slice(0, 300)}`);
    const cmds = parseCommands(res.text, sessionId);
    if (cmds.length === 0) {
      log(sessionId, "no commands to run (NONE or all invalid)");
      return 0;
    }
    for (const cmd of cmds) {
      const rc = await runCcs(cmd.slice(1)); // strip leading "ccs"
      log(sessionId, `ran: ${cmd.join(" ")} → rc=${rc}`);
    }
    // After any updates land, repaint the tab so the sidebar reflects the new state. The Stop
    // hook's earlier pushRenderOps painted PRE-update state (sidecar runs async); this is the
    // one that shows the sidecar's decisions. Best-effort.
    try {
      const { pushRenderOps } = await import("../catalogue/sync-tabs.ts");
      pushRenderOps(sessionId);
      log(sessionId, "repainted tab");
    } catch (e) {
      log(sessionId, `repaint failed: ${(e as Error).message}`);
    }
    return 0;
  } finally {
    releaseLock(sessionId);
  }
}
