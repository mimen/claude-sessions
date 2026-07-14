/**
 * `ccs identity resolve --session <sid> [--json]` — resolve a session to its identity KEY plus
 * the columns it's derived from. Same purpose as `ccs catalogue export` at the row level: the
 * ONE authorized way for a cluster engine to ask "what identity is this session?" instead of
 * re-implementing the derivation.
 *
 * Also handy for humans: `ccs identity resolve --session abc123` shows exactly why a session is
 * grouped where it is.
 */
import { openCatalogue, getRow, identityKeyOf } from "./db.ts";
import { CATALOGUE_PATH } from "../paths.ts";

export interface IdentityResolveResult {
  schema: number;
  sessionId: string;
  key: string | null;
  role: string | null;
  cluster: string | null;
  workUnitId: string | null;
  gusWork: string | null;
  prRepo: string | null;
  prNumber: number | null;
  updatedAt: string | null;
}

export function identityResolveCommand(args: string[]): number {
  const sub = args[0];
  if (sub !== "resolve") {
    console.error("usage: ccs identity resolve --session <sid> [--json]");
    return 1;
  }
  const rest = args.slice(1);
  const sIdx = rest.indexOf("--session");
  const sessionId = sIdx >= 0 ? rest[sIdx + 1] : null;
  if (!sessionId) {
    console.error("--session <id> required");
    return 1;
  }

  const db = openCatalogue(CATALOGUE_PATH());
  const row = getRow(db, sessionId);
  if (!row) {
    // Emit a null-valued envelope with count 0, non-error — cluster engines can key on `key`.
    const out: IdentityResolveResult = {
      schema: 1,
      sessionId,
      key: null,
      role: null,
      cluster: null,
      workUnitId: null,
      gusWork: null,
      prRepo: null,
      prNumber: null,
      updatedAt: null,
    };
    console.log(JSON.stringify(out));
    return 0;
  }
  const out: IdentityResolveResult = {
    schema: 1,
    sessionId,
    key: identityKeyOf(row),
    role: row.role,
    cluster: row.cluster,
    workUnitId: row.workUnitId,
    gusWork: row.gusWork,
    prRepo: row.prRepo,
    prNumber: row.prNumber,
    updatedAt: row.updatedAt,
  };
  console.log(JSON.stringify(out));
  return 0;
}
