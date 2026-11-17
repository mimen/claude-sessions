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
 * Every field routed through this command uses the SAME db-mutations.ts setter the equivalent CLI command
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
 *   saved                -> setSaved (boolean)
 *   archived             -> compatibility alias for completed (boolean)
 *   meta                 -> setMeta per key (object of key→value; null values delete)
 *   enrichment           -> setEnrichment (REQUIRES --sensor; whole object, written atomically)
 *
 * Usage:
 *   ccs session-fields <sid> --json '{"cluster":"pr-watch","gusWork":"W-...","stage":"building"}' --sensor catalogue-sync
 *
 * Returns exit 0 on success. Prints a JSON summary of applied fields (or the first field's
 * validation error on non-zero exit).
 */
import { z } from "zod";
import { openCatalogue } from "./db-schema.ts";
import { getRow } from "./db-queries.ts";
import { setCustomTitle, setRole, setProject, setCluster, setGusWork, setWorkUnitId, setStatusLine, setParked, setParent, setKey, setCompleted, setArchived, setSaved, setMeta, setStage, setEnrichment, setSessionEpic } from "./db-mutations.ts";
import { validateStageTransition } from "./stage-schema.ts";
import { EnrichmentPayloadSchema, validateEnrichment } from "./enrichment-schema.ts";
import { loadEnrichmentLocations, locationKeySet } from "../enrich/locations.ts";
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

const BOOL_FIELDS: Record<string, (db: any, sid: string, v: boolean, now: string) => void> = {};

/**
 * The enrichment object as an external sensor writes it: the model's assertions plus the message
 * count they were made against. `atMessages` is required because staleness is meaningless without
 * it — a summary that doesn't say which version of the transcript it describes can never be known
 * to be out of date. `at` defaults to now, since a writer persisting immediately has no reason to
 * carry a timestamp.
 */
const EnrichmentWriteSchema = EnrichmentPayloadSchema.extend({
  atMessages: z.number().int().nonnegative(),
  at: z.string().min(1).optional(),
});

function nowIso(): string {
  return new Date().toISOString();
}

/** A flag's value, from `--flag=value` or the next argv token. The next index to visit is `next`. */
function takeFlag(args: string[], index: number): { value: string; next: number } | undefined {
  const arg = args[index]!;
  const eq = arg.indexOf("=");
  if (eq !== -1) return { value: arg.slice(eq + 1), next: index };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) return undefined;
  return { value, next: index + 1 };
}

function parseSessionFieldsArgs(args: string[]): { sid: string; jsonStr: string; sensor: string | null } | string {
  let jsonStr: string | undefined;
  let sensor: string | null = null;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" || arg.startsWith("--json=")) {
      if (jsonStr !== undefined) return "pass --json only once";
      const taken = takeFlag(args, i);
      if (!taken) return "--json requires a value";
      jsonStr = taken.value;
      i = taken.next;
      continue;
    }
    if (arg === "--sensor" || arg.startsWith("--sensor=")) {
      if (sensor !== null) return "pass --sensor only once";
      const taken = takeFlag(args, i);
      if (!taken) return "--sensor requires a value";
      sensor = taken.value;
      i = taken.next;
      continue;
    }
    if (arg.startsWith("--")) return `unknown flag: ${arg}`;
    positionals.push(arg);
  }
  if (!jsonStr) return "--json '{...}' is required";
  if (positionals.length !== 1) return "usage: ccs session-fields <sid> --json '{...}' [--sensor <name>]";
  return { sid: positionals[0]!, jsonStr, sensor };
}

function reject(message: string, code = 1): never {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  throw error;
}

export function sessionFieldsCommand(args: string[]): number {
  const parsedArgs = parseSessionFieldsArgs(args);
  if (typeof parsedArgs === "string") {
    console.error(parsedArgs.startsWith("usage:") ? parsedArgs : `ccs session-fields: ${parsedArgs}`);
    return 1;
  }
  const { sid, jsonStr, sensor } = parsedArgs;
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
  const now = nowIso();

  ensureDataDir();
  const db = openCatalogue(CATALOGUE_PATH());
  const applied: string[] = [];
  try {
    db.transaction(() => {
    // Validate stage first (needs schema lookup + sensor check) so we fail loud before any write.
    if ("stage" in payload) {
      if (!sensor) {
        reject("ccs session-fields: writing 'stage' requires --sensor <name> (ADR-0079: stage is engine-computed).", 2);
      }
      const stageVal = payload.stage;
      if (stageVal !== null && typeof stageVal !== "string") {
        reject("ccs session-fields: stage must be a string or null");
      }
      if (stageVal !== null) {
        const row = getRow(db, sid);
        const schema = row?.role ? resolveRole(row.role, row.cluster)?.stageSchema ?? null : null;
        const err = validateStageTransition(schema, row?.stage ?? null, stageVal);
        if (err) {
          reject(`ccs session-fields: stage: ${err}`);
        }
      }
    }

    for (const [field, value] of Object.entries(payload)) {
      if (field === "stage") {
        setStage(db, sid, value === null ? null : (value as string), now);
        applied.push(`stage=${value ?? "null"} (sensor=${sensor})`);
        continue;
      }
      if (field === "enrichment") {
        // Enrichment is sensor-produced OBSERVED state, so it carries the same guard as `stage`
        // (ADR-0079): a worker must not be able to write its own flattering summary and
        // recommendation into the catalogue through the bulk primitive.
        if (!sensor) {
          reject("ccs session-fields: writing 'enrichment' requires --sensor <name> (observed state, not self-reported).", 2);
        }
        const parsed = EnrichmentWriteSchema.safeParse(value);
        if (!parsed.success) {
          reject(`ccs session-fields: enrichment: ${z.prettifyError(parsed.error)}`);
        }
        // The same coherence check the enrich command applies, against this machine's registry —
        // otherwise an external writer could store a location key that resolves to nothing here.
        const problem = validateEnrichment(parsed.data, locationKeySet(loadEnrichmentLocations()));
        if (problem) {
          reject(`ccs session-fields: enrichment: ${problem}`);
        }
        setEnrichment(db, sid, { ...parsed.data, at: parsed.data.at ?? now }, now);
        applied.push(`enrichment=${parsed.data.recommendation} (sensor=${sensor})`);
        continue;
      }
      if (field === "meta") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          reject("ccs session-fields: 'meta' must be an object");
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
          reject(`ccs session-fields: ${field} must be a string or null`);
        }
        strSetter(db, sid, value as string | null, now);
        applied.push(`${field}=${value ?? "null"}`);
        continue;
      }
      if (field === "completed") {
        if (typeof value !== "boolean") {
          reject("ccs session-fields: completed must be a boolean");
        }
        setCompleted(db, sid, value, now);
        if (value) {
          setArchived(db, sid, false, now);
          setSaved(db, sid, false, now);
          setParked(db, sid, null, now);
        }
        applied.push(`completed=${value}`);
        continue;
      }
      if (field === "saved") {
        if (typeof value !== "boolean") {
          reject("ccs session-fields: saved must be a boolean");
        }
        setSaved(db, sid, value, now);
        if (value) {
          setCompleted(db, sid, false, now);
          setArchived(db, sid, false, now);
        }
        applied.push(`saved=${value}`);
        continue;
      }
      if (field === "archived") {
        if (typeof value !== "boolean") {
          reject("ccs session-fields: archived must be a boolean");
        }
        setCompleted(db, sid, value, now);
        setArchived(db, sid, false, now);
        if (value) setSaved(db, sid, false, now);
        applied.push(`completed=${value} (archive alias)`);
        continue;
      }
      const boolSetter = BOOL_FIELDS[field];
      if (boolSetter) {
        if (typeof value !== "boolean") {
          reject(`ccs session-fields: ${field} must be a boolean`);
        }
        boolSetter(db, sid, value, now);
        applied.push(`${field}=${value}`);
        continue;
      }
      reject(`ccs session-fields: unknown field '${field}'`);
    }
    })();
  } catch (error) {
    const coded = error as Error & { code?: number };
    console.error(typeof coded.code === "number" ? coded.message : `ccs session-fields: ${(error as Error).message}`);
    return typeof coded.code === "number" ? coded.code : 1;
  } finally {
    db.close();
  }
  // Kick a single-identity recompose so the composed board picks up the writes on the same tick.
  recomposeForSession(sid);
  console.log(JSON.stringify({ sessionId: sid, applied }));
  return 0;
}
