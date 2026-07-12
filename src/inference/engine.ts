import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import type { Config } from "../config.ts";

/**
 * The one place `ccs` runs LLM inference. Every call is structured (schema-forced),
 * non-agentic, and hermetic: pipe a bounded `stdin` payload, force a JSON `schemaPath`,
 * get back the parsed object or null. Two interchangeable backends sit behind one interface
 * — the Codex CLI (rides ChatGPT/OpenAI auth, no marginal cost) and the Claude Code CLI
 * (`claude -p`). See ADR-0001, which anticipated this swap being a one-file change.
 */
export type EngineName = "codex" | "claude";

export interface InferenceEngine {
  readonly name: EngineName;
  /** Whether the backing CLI is resolvable right now. Cached after the first probe. */
  available(): boolean;
  /**
   * Run one structured inference. `prompt` is the instruction, `stdin` the data payload,
   * `schemaPath` a JSON-Schema file the response must satisfy. Returns the parsed object
   * (caller casts to its expected shape) or null on any failure/timeout.
   */
  runStructured(opts: {
    prompt: string;
    stdin: string;
    schemaPath: string;
    timeoutMs?: number;
  }): Promise<unknown | null>;
}

/** Whether an executable is resolvable on PATH. Bun.spawn ignores shell aliases, so this
 *  mirrors what the engine will actually find when it spawns. */
export function binaryExists(binary: string): boolean {
  try {
    return Bun.spawnSync(["which", binary], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

/** Probe a binary once and cache the result — avoids a `which` per call. */
function lazyAvailability(binary: string): () => boolean {
  let cached: boolean | null = null;
  return () => {
    if (cached === null) cached = binaryExists(binary);
    return cached;
  };
}

/**
 * Codex backend. Runs `codex exec` hermetically (ephemeral, read-only sandbox, user
 * config/rules ignored) with `--output-schema` forcing the response and
 * `--output-last-message` capturing it to a temp file.
 */
export function createCodexEngine(opts: {
  binary: string;
  model: string;
  reasoningEffort: string;
}): InferenceEngine {
  const available = lazyAvailability(opts.binary);
  return {
    name: "codex",
    available,
    async runStructured({ prompt, stdin, schemaPath, timeoutMs = 60_000 }): Promise<unknown | null> {
      const outPath = join(tmpdir(), `ccs-infer-${randomUUID()}.json`);
      const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--ignore-rules",
        "--ignore-user-config",
        "-c",
        `model_reasoning_effort="${opts.reasoningEffort}"`,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outPath,
      ];
      if (opts.model) args.push("-m", opts.model);
      args.push(prompt);

      try {
        const proc = Bun.spawn([opts.binary, ...args], {
          stdin: new TextEncoder().encode(stdin),
          stdout: "ignore",
          stderr: "ignore",
        });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const code = await proc.exited;
        clearTimeout(timer);
        if (code !== 0) return null;
        return JSON.parse(readFileSync(outPath, "utf8")) as unknown;
      } catch {
        return null;
      } finally {
        rmSync(outPath, { force: true });
      }
    },
  };
}

/**
 * Claude Code backend. Runs `claude -p` non-interactively with `--json-schema` forcing a
 * structured response and `--output-format json`; the schema is passed inline (Claude wants
 * the JSON, not a path). `--strict-mcp-config` keeps the call cheap and hermetic by loading
 * no MCP servers. The parsed object comes back on the result envelope's `structured_output`.
 */
export function createClaudeEngine(opts: {
  binary: string;
  model: string;
}): InferenceEngine {
  const available = lazyAvailability(opts.binary);
  return {
    name: "claude",
    available,
    async runStructured({ prompt, stdin, schemaPath, timeoutMs = 60_000 }): Promise<unknown | null> {
      let schemaInline: string;
      try {
        // Collapse to a single line so it rides cleanly as one argv entry.
        schemaInline = JSON.stringify(JSON.parse(readFileSync(schemaPath, "utf8")));
      } catch {
        return null;
      }
      const args = ["-p", "--strict-mcp-config", "--output-format", "json", "--json-schema", schemaInline];
      if (opts.model) args.push("--model", opts.model);
      args.push(prompt);

      try {
        const proc = Bun.spawn([opts.binary, ...args], {
          stdin: new TextEncoder().encode(stdin),
          stdout: "pipe",
          stderr: "ignore",
        });
        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        clearTimeout(timer);
        if (code !== 0) return null;

        const envelope = JSON.parse(out) as { structured_output?: unknown; result?: unknown };
        // Prefer the pre-parsed structured field; fall back to parsing the result string.
        if (envelope.structured_output && typeof envelope.structured_output === "object") {
          return envelope.structured_output;
        }
        return typeof envelope.result === "string" ? (JSON.parse(envelope.result) as unknown) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Construct the engine for a given name from config. */
export function buildEngine(name: EngineName, config: Config): InferenceEngine {
  if (name === "claude") {
    return createClaudeEngine({ binary: config.inference.claude.binary, model: config.inference.claude.model });
  }
  return createCodexEngine({
    binary: config.inference.codex.binary,
    model: config.inference.codex.model,
    reasoningEffort: config.inference.codex.reasoningEffort,
  });
}

/** Preference order for `auto`: Codex first (rides free auth per ADR-0001), then Claude. */
const AUTO_ORDER: readonly EngineName[] = ["codex", "claude"];

/** Which engines are actually installed on this host, in preference order. */
export function detectAvailable(config: Config): EngineName[] {
  return AUTO_ORDER.filter((name) => buildEngine(name, config).available());
}

export interface EngineSelection {
  /** The engine to use now (best available). Null when nothing is installed. */
  readonly name: EngineName | null;
  /** Every installed engine, in preference order — drives whether the toggle is offered. */
  readonly available: EngineName[];
  /** What was requested (env > config), before availability fell it back. */
  readonly requested: EngineName | "auto";
  /** True when the requested engine wasn't installed and we fell back to another. */
  readonly fellBack: boolean;
}

const ENGINE_ENV = "CCS_INFERENCE_ENGINE";

function normalizeName(value: string | undefined | null): EngineName | "auto" | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return v === "codex" || v === "claude" || v === "auto" ? v : null;
}

/**
 * Resolve which engine to run with. Precedence: `CCS_INFERENCE_ENGINE` env → `override`
 * (e.g. a persisted TUI toggle) → `config.inference.engine` → `auto`. An explicit request
 * that isn't installed falls back to the best available one rather than failing.
 */
export function resolveEngine(config: Config, override?: EngineName | null): EngineSelection {
  const available = detectAvailable(config);
  const requested: EngineName | "auto" =
    normalizeName(process.env[ENGINE_ENV]) ?? override ?? normalizeName(config.inference.engine) ?? "auto";

  if (requested !== "auto" && available.includes(requested)) {
    return { name: requested, available, requested, fellBack: false };
  }
  const name = available[0] ?? null;
  return { name, available, requested, fellBack: requested !== "auto" && name !== null };
}
