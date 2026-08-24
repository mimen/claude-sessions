/**
 * Primitive 8 — directory facts: project identity for the directories rows belong to.
 *
 * A directory's checkout (project, worktree, branch) and favicon cost git calls and stats but
 * move on no cadence the sidebar cares about, so the underlying cache holds them for a TTL.
 * This primitive adds the contract the other primitives carry: one read, and a revision that
 * advances only when the resolved facts for the requested directories actually changed.
 * Per-directory failure degrades to omission — a row loses its project label, never its place.
 */
import type { DirectoryFactsResult } from "../directory-facts.ts";

export interface DirectoryFactsRead extends DirectoryFactsResult {
  readonly revision: number;
}

export interface DirectoryFactsPrimitiveIo {
  lookup(directories: readonly string[]): Promise<DirectoryFactsResult>;
}

export function createDirectoryFactsPrimitive(io: DirectoryFactsPrimitiveIo): {
  read(directories: readonly string[]): Promise<DirectoryFactsRead>;
} {
  let revision = 0;
  let lastIdentity: string | null = null;

  function identityOf(result: DirectoryFactsResult): string {
    const checkout = [...result.checkouts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, c]) => `${dir}=${c.project}/${c.worktree ?? ""}/${c.branch ?? ""}`)
      .join(",");
    const favicon = [...result.favicons.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dir, p]) => `${dir}=${p}`)
      .join(",");
    return `${checkout}|${favicon}`;
  }

  return {
    async read(directories: readonly string[]): Promise<DirectoryFactsRead> {
      const result = await io.lookup(directories);
      const identity = identityOf(result);
      if (identity !== lastIdentity) {
        revision += 1;
        lastIdentity = identity;
      }
      return { ...result, revision };
    },
  };
}
