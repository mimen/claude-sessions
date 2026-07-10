import { existsSync } from "node:fs";
import { openCatalogue, getRow } from "../catalogue/db.ts";
import { openIndex } from "../index/schema.ts";
import { CATALOGUE_PATH, DB_PATH } from "../paths.ts";
import { resolvePredecessors } from "../catalogue/lineage.ts";

/**
 * Compose the predecessor-rehydration context (ADR-0038, source 1): on a fresh embodiment of an
 * identity that has had prior sessions, surface those predecessors' transcripts so the new body
 * reviews what past bodies did/tried/concluded — the identity's episodic memory across bodies.
 *
 * This is the third rehydration source alongside claude-md (composed context) and inbox+state
 * (drained on start). It points the agent AT the transcripts rather than inlining them (they're
 * large); the agent reads the ones it needs. Best-effort / fail-open — a hook must never block.
 *
 * Only emits for a session with actual predecessors (a solo identity gets nothing), and only
 * on a fresh start (not a resume of the same session — that keeps its own transcript).
 */
export function composePredecessors(sessionId: string): string | null {
  try {
    if (!existsSync(CATALOGUE_PATH()) || !existsSync(DB_PATH())) return null;
    const catalogue = openCatalogue(CATALOGUE_PATH());
    const index = openIndex(DB_PATH());
    try {
      // Skip if this session isn't itself registered (nothing to key a lineage on).
      if (!getRow(catalogue, sessionId)) return null;
      const preds = resolvePredecessors(catalogue, index, sessionId);
      const withTranscripts = preds.filter((p) => p.transcriptPath);
      if (withTranscripts.length === 0) return null;

      const lines = withTranscripts.map((p) => {
        const state = p.completed ? "completed" : p.archived ? "archived" : "prior";
        return `- ${p.sessionId.slice(0, 8)} (${state}): ${p.transcriptPath}`;
      });
      return (
        `## predecessors\n` +
        `This identity has had ${withTranscripts.length} prior embodiment(s). You carry their ` +
        `work forward — review what they did/tried/concluded before rediscovering it. Their ` +
        `transcripts (oldest first), read the recent ones as needed:\n` +
        lines.join("\n")
      );
    } finally {
      catalogue.close();
      index.close();
    }
  } catch {
    return null; // fail-open
  }
}
