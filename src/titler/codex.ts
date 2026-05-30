import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";

/** Generates a Session Title from its skeleton. Returns null on any failure. */
export interface Titler {
  generate(skeleton: string): Promise<string | null>;
  /** Whether the backing tool is usable right now. When false, the backfill skips entirely
   *  instead of recording a failed attempt against every Session. */
  available(): boolean;
}

/** Whether an executable is resolvable on PATH (used to skip titling when codex is absent). */
export function binaryExists(binary: string): boolean {
  try {
    return Bun.spawnSync(["which", binary], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

export interface CodexTitlerOptions {
  /** Codex executable name or path. */
  binary: string;
  /** Model override; empty string inherits the user's Codex default (account-safe). */
  model: string;
  reasoningEffort: string;
  /** Per-call wall-clock limit. */
  timeoutMs?: number;
}

const SCHEMA_PATH = join(import.meta.dir, "schema.json");

const PROMPT =
  "You title Claude Code coding/assistant sessions. Given the transcript excerpt in the " +
  "<stdin> block, produce ONE concise title: max 60 characters, imperative mood, no " +
  "surrounding quotes, no trailing period. Respond using the provided JSON schema.";

/**
 * Codex-backed Titler. Runs `codex exec` hermetically (ephemeral, read-only sandbox, user
 * config/rules ignored) with structured output, piping the skeleton via stdin. See ADR-0001.
 */
export function createCodexTitler(opts: CodexTitlerOptions): Titler {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  // Probe the binary once and cache it — avoids a `which` per Session.
  let available: boolean | null = null;

  return {
    available(): boolean {
      if (available === null) available = binaryExists(opts.binary);
      return available;
    },
    async generate(skeleton: string): Promise<string | null> {
      if (!skeleton.trim()) return null;
      const outPath = join(tmpdir(), `ccs-title-${randomUUID()}.json`);

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
        SCHEMA_PATH,
        "--output-last-message",
        outPath,
      ];
      if (opts.model) args.push("-m", opts.model);
      args.push(PROMPT);

      try {
        const proc = Bun.spawn([opts.binary, ...args], {
          stdin: new TextEncoder().encode(skeleton),
          stdout: "ignore",
          stderr: "ignore",
        });

        const timer = setTimeout(() => proc.kill(), timeoutMs);
        const code = await proc.exited;
        clearTimeout(timer);
        if (code !== 0) return null;

        const raw = readFileSync(outPath, "utf8");
        const parsed = JSON.parse(raw) as { title?: unknown };
        const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
        return title || null;
      } catch {
        return null;
      } finally {
        rmSync(outPath, { force: true });
      }
    },
  };
}
