/**
 * `ccs session-fields <sid> --json '{...}' [--sensor <name>]` — atomic multi-field write.
 *
 * ADR-0078 finish-line (2026-07-14). catalogue_sync.py (and any other cluster hot-path composer)
 * needs to write 5+ fields per session per tick. Doing that as 5 subprocess calls is either
 * ~60 forks/tick (perf) or 5 non-atomic writes (correctness — a crash mid-sequence leaves a
 * partial row). A single subprocess with a JSON body writes all fields in ONE mutation-boundary
 * pass, atomic per session, and each field goes through the same setter the CLI's single-field
 * commands use.
 *
 * Every field routed through this command uses the SAME db.ts setter the equivalent CLI command
 * uses. There is no new mutation path — this is just batching, not a bypass.
 *
 * Stage writes require --sensor <name> for the same reason `ccs stage` does (D5 / ADR-0079):
 * only sensors write stage; workers can't smuggle a stage change through the bulk primitive.
 *
 * Accepted fields (mirror the setter names for grep-ability):
 *   customTitle          -> setCustomTitle
 *   role                 -> setRole
 *   project              -> setProject
 *   cluster              -> setCluster
 *   gusWork              -> setGusWork
 *   workUnitId           -> setWorkUnitId
 *   groupingId (a.k.a. epic) -> setSessionEpic
 *   stage                -> setStage (REQUIRES --sensor)
 *   statusLine           -> setStatusLine
 *   parkedTaskId         -> setParked
 *   parentSessionId      -> setParent
 *   key                  -> setKey (freeform anchor — see ADR-0069/0078)
 *   completed            -> setCompleted (boolean)
 *   archived             -> setArchived (boolean)
 *   meta                 -> setMeta per key (object of key→value; null values delete)
 *
 * Usage:
 *   ccs session-fields <sid> --json '{"cluster":"pr-watch","gusWork":"W-...","stage":"building"}' --sensor catalogue-sync
 *
 * Returns exit 0 on success. Prints a JSON summary of applied fields (or the first field's
 * validation error on non-zero exit).
 */
import { openCatalogue, getRow,
  setCustomTitle, setRole, setProject, setCluster, setGusWork, setWorkUnitId,
  setStatusLine, setParked, setParent, setKey, setCompleted, setArchived,
  setMeta, setStage,
  setSessionEpic,
} from "./db.ts";
import { validateStageTransition } from "./stage-schema.ts";
import { resolveRole } from "../roles/role-files.ts";
import { CATALOGUE_PATH, ensureDataDir } from "../paths.ts";
import { recomposeForSession } from "../board/recompose.ts";

const STRING_OR_NULL_FIELDS: Record<string, (db: any, sid: string, v: string | null, now: string) => void> = {
  customTitle: setCustomTitle,
  role: setRole,
  project: setProject,
  cluster: setCluster,
  gusWork: setGusWork,
  workUnitId: setWorkUnitId,
  groupingId: setSessionEpic,
  statusLine: setStatusLine,
  parkedTaskId: setParked,
  parentSessionId: setParent,
  key: setKey,
};

const BOOL_FIELDS: Record<string, (db: any, sid: string, v: boolean, now: string) => void> = {
  completed: setCompleted,
  archived: setArchived,
};

function nowIso(): string {
  return new Date().toISOString();
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function sessionFieldsCommand(args: string[]): number {
  const sid = args.find((a) => !a.startsWith("--"));
  if (!sid) {
    console.error("usage: ccs session-fields <sid> --json '{...}' [--sensor <name>]");
    return 1;
  }
  const jsonStr = flagValue(args, "--json");
  if (!jsonStr) {
    console.error("--json '{...}' is required");
    return 1;
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(jsonStr);
  } catch (e) {
    console.error(`ccs session-fields: invalid JSON: ${(e as Error).message}`);
    return 1;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    console.error("ccs session-fields: --json must be a JSON object");
    return 1;
  }
  const sensor = flagValue(args, "--sensor") ?? null;
  const now = nowIso();

  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  const applied: string[] = [];
  try {
    // Validate stage first (needs schema lookup + sensor check) so we fail loud before any write.
    if ("stage" in payload) {
      if (!sensor) {
        console.error("ccs session-fields: writing 'stage' requires --sensor <name> (ADR-0079: stage is engine-computed).");
        return 2;
      }
      const stageVal = payload.stage;
      if (stageVal !== null && typeof stageVal !== "string") {
        console.error("ccs session-fields: stage must be a string or null");
        return 1;
      }
      if (stageVal !== null) {
        const row = getRow(db, sid);
        const schema = row?.role ? resolveRole(row.role, row.cluster)?.stageSchema ?? null : null;
        const err = validateStageTransition(schema, row?.stage ?? null, stageVal);
        if (err) {
          console.error(`ccs session-fields: stage: ${err}`);
          return 1;
        }
      }
    }

    for (const [field, value] of Object.entries(payload)) {
      if (field === "stage") {
        setStage(db, sid, value === null ? null : (value as string), now);
        applied.push(`stage=${value ?? "null"} (sensor=${sensor})`);
        continue;
      }
      if (field === "meta") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          console.error("ccs session-fields: 'meta' must be an object");
          return 1;
        }
        for (const [mk, mv] of Object.entries(value as Record<string, unknown>)) {
          setMeta(db, sid, mk, mv, now);
          applied.push(`meta.${mk}=${JSON.stringify(mv)}`);
        }
        continue;
      }
      const strSetter = STRING_OR_NULL_FIELDS[field];
      if (strSetter) {
        if (value !== null && typeof value !== "string") {
          console.error(`ccs session-fields: ${field} must be a string or null`);
          return 1;
        }
        strSetter(db, sid, value as string | null, now);
        applied.push(`${field}=${value ?? "null"}`);
        continue;
      }
      const boolSetter = BOOL_FIELDS[field];
      if (boolSetter) {
        if (typeof value !== "boolean") {
          console.error(`ccs session-fields: ${field} must be a boolean`);
          return 1;
        }
        boolSetter(db, sid, value, now);
        applied.push(`${field}=${value}`);
        continue;
      }
      console.error(`ccs session-fields: unknown field '${field}'`);
      return 1;
    }
  } finally {
    db.close();
  }
  // Kick a single-identity recompose so the composed board picks up the writes on the same tick.
  recomposeForSession(sid);
  console.log(JSON.stringify({ sessionId: sid, applied }));
  return 0;
}
