import { join } from "node:path";
import type { InferenceEngine } from "../inference/engine.ts";

/** Generates a Session Title from its skeleton. Returns null on any failure. */
export interface Titler {
  generate(skeleton: string): Promise<string | null>;
  /** Whether the backing engine is usable right now. When false, the backfill skips entirely
   *  instead of recording a failed attempt against every Session. */
  available(): boolean;
}

const SCHEMA_PATH = join(import.meta.dir, "schema.json");

const PROMPT =
  "You title Claude Code coding/assistant sessions. Given the transcript excerpt in the " +
  "<stdin> block, produce ONE concise title: max 60 characters, imperative mood, no " +
  "surrounding quotes, no trailing period. Respond using the provided JSON schema.";

/**
 * A Titler backed by an {@link InferenceEngine}. The engine (Codex or Claude) runs one
 * hermetic, schema-forced call per Session, piping the skeleton via stdin. See ADR-0001.
 */
export function createTitler(engine: InferenceEngine, timeoutMs = 60_000): Titler {
  return {
    available(): boolean {
      return engine.available();
    },
    async generate(skeleton: string): Promise<string | null> {
      if (!skeleton.trim()) return null;
      const parsed = (await engine.runStructured({
        prompt: PROMPT,
        stdin: skeleton,
        schemaPath: SCHEMA_PATH,
        timeoutMs,
      })) as { title?: unknown } | null;
      const title = parsed && typeof parsed.title === "string" ? parsed.title.trim() : "";
      return title || null;
    },
  };
}
