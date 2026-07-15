import { openCatalogue, getAll, identityKeyOf } from "../catalogue/db.ts";
import { CATALOGUE_PATH } from "../paths.ts";
import type { Board, BoardRow } from "./types.ts";
import { readBoard, writeBoard } from "./paths.ts";

export function runDefaultComposer(cluster: string, opts: { identity?: string } = {}): void {
  const catalogueDb = openCatalogue(CATALOGUE_PATH());
  const rows: BoardRow[] = [];
  for (const [sid, catRow] of getAll(catalogueDb)) {
    if (catRow.cluster !== cluster) continue;
    const identity = identityKeyOf(catRow);
    if (!identity) continue;
    if (opts.identity && identity !== opts.identity) continue;
    // Default composer emits NO pills — the tool doesn't know any cluster's stage vocabulary.
    // Clusters that want a pill provide their own composer via cluster.toml's `board` entry.
    rows.push({
      identity,
      workUnit: {
        kind: catRow.prNumber ? "pr" : "gus",
        ...(catRow.prNumber ? { prNumber: catRow.prNumber, prRepo: catRow.prRepo } : {}),
        ...(catRow.gusWork ? { gusWork: catRow.gusWork } : {}),
        ...(catRow.workUnitId ? { workUnitId: catRow.workUnitId } : {}),
      },
      sessions: [{ sessionId: sid, isPrimary: true, lastActivity: catRow.updatedAt ?? "" }],
      pills: [],
      description: catRow.statusLine ?? null,
      alerts: [],
      awaitingFrom: [],
      lastComposed: new Date().toISOString(),
    });
  }
  const board: Board = {
    status: "OK",
    provenance: { source: "ccs-default-composer", at: new Date().toISOString() },
    rows,
  };
  if (opts.identity) {
    const current = readBoard(cluster) ?? { status: "OK", provenance: board.provenance, rows: [] };
    const filtered = current.rows.filter((r) => r.identity !== opts.identity);
    board.rows = [...filtered, ...rows];
  }
  writeBoard(cluster, board);
}
