import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { applyMutations, normalizeMutationValue, MUTATION_OPS, type Mutation } from "./command.ts";
import { sameHost } from "./ownership.ts";
import { type Result, ok, err } from "../result.ts";

/**
 * Catalogue edit intents (issue 33): editing a row another Host owns is not a local write —
 * it's a message. The edit rides the fleet protocol as an `edit-intent` envelope (the reserved
 * type; see machine-adapter/PROTOCOL.md) into the applier role's inbox. That inbox is SHARED
 * fleet state (it rides Sync), and intents inside it are addressed per-Host via `body.host` —
 * so consumption is SELECTIVE: each Host applies and marks only its own envelopes, leaving the
 * rest in place for their Host's pass. (`fleet drain --mark` would consume everything for
 * everyone — a wrong-Host intent drained that way is lost to the shared dedupe ledger.)
 * Envelope EMISSION stays fleet.py's job — the one implementation.
 */

export interface SendIntentOptions {
  /** Path to fleet.py (config `fleet.cli`). */
  readonly fleetCli: string;
  /** Role whose inbox receives the intent (config `fleet.intentRole`). */
  readonly toRole: string;
  /** Envelope `from` — identifies the emitting ccs, e.g. `ccs-Milads-M3-2`. */
  readonly fromLabel: string;
  /** The Host the merged view says owns the row (body.host — the applier's address). */
  readonly ownerHost: string;
  readonly mutations: readonly Mutation[];
  /** Extra fleet.py args (tests: --vault/--roles-dir overrides). */
  readonly fleetArgs?: readonly string[];
}

/** Emit an edit-intent envelope via the fleet CLI. Ok carries the CLI's verdict line. */
export function sendIntent(opts: SendIntentOptions): Result<string> {
  if (!existsSync(opts.fleetCli)) {
    return err(new Error(`fleet CLI not found at ${opts.fleetCli} (config [fleet] cli)`));
  }
  const body = JSON.stringify({ host: opts.ownerHost, mutations: opts.mutations });
  const proc = Bun.spawnSync(
    [
      "python3", opts.fleetCli, ...(opts.fleetArgs ?? []),
      "send", opts.toRole, "--from", opts.fromLabel, "--type", "edit-intent", "--body", body,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = new TextDecoder().decode(proc.stdout).trim();
  const errText = new TextDecoder().decode(proc.stderr).trim();
  if (proc.exitCode !== 0) {
    return err(new Error(errText || out || `fleet send exited ${proc.exitCode}`));
  }
  return ok(out);
}

export interface ApplyIntentsOptions {
  /** This Host's name (localHostName()). */
  readonly localHost: string;
  /** Merged-view ownership lookup; null = unknown (treated as local, matching write guards). */
  readonly ownerOf: (sessionId: string) => string | null;
  readonly now: string;
}

/** One envelope's fate when applied. */
export type IntentOutcome =
  | { kind: "applied"; applied: number; refused: Mutation[] }
  | { kind: "wrong-host"; host: string }
  | { kind: "not-an-intent" }
  | { kind: "malformed"; reason: string };

/** A session id we'd accept in a mutation: one whitespace-free token (UUIDs, agent-… run ids) —
 *  rejects the junk-row class (pasted multi-line text keyed as an "id"). */
const INTENT_SESSION_ID_RE = /^\S{2,100}$/;

/**
 * Judge + apply ONE envelope against the local catalogue. Boundary-validates everything —
 * envelopes are external input from an open protocol (body may be any JSON value).
 */
export function applyIntentEnvelope(
  catalogue: Database,
  envelope: unknown,
  opts: ApplyIntentsOptions,
): IntentOutcome {
  if (typeof envelope !== "object" || envelope === null) return { kind: "malformed", reason: "not an object" };
  const e = envelope as { type?: unknown; body?: unknown };
  if (e.type !== "edit-intent") return { kind: "not-an-intent" };
  if (typeof e.body !== "object" || e.body === null) {
    return { kind: "malformed", reason: "edit-intent body is not an object" };
  }
  const body = e.body as { host?: unknown; mutations?: unknown };
  if (body.host !== undefined && typeof body.host !== "string") {
    return { kind: "malformed", reason: "body.host is not a string" };
  }
  if (typeof body.host === "string" && !sameHost(body.host, opts.localHost)) {
    return { kind: "wrong-host", host: body.host };
  }
  if (!Array.isArray(body.mutations)) {
    return { kind: "malformed", reason: "edit-intent body has no mutations array" };
  }
  const applicable: Mutation[] = [];
  const refused: Mutation[] = [];
  for (const raw of body.mutations) {
    const m = raw as { sessionId?: unknown; op?: unknown; value?: unknown };
    const op = m?.op as Mutation["op"];
    if (
      typeof m?.sessionId !== "string" ||
      !INTENT_SESSION_ID_RE.test(m.sessionId) ||
      !MUTATION_OPS.includes(op) ||
      (m.value !== null && m.value !== undefined && typeof m.value !== "string")
    ) {
      return { kind: "malformed", reason: "mutation is not {sessionId, op, value: string|null}" };
    }
    const owner = opts.ownerOf(m.sessionId);
    const mutation: Mutation = { sessionId: m.sessionId, op, value: (m.value as string | null) ?? null };
    if (owner && !sameHost(owner, opts.localHost)) {
      refused.push(mutation);
      continue;
    }
    // Normalize on apply too — senders vary, spellings must not ("yes" !== "true" bit us once).
    const norm = normalizeMutationValue(op, mutation.value);
    if ("skip" in norm) continue;
    applicable.push({ ...mutation, value: norm.value });
  }
  if (applicable.length) applyMutations(catalogue, applicable, opts.now);
  return { kind: "applied", applied: applicable.length, refused };
}

export interface ApplyIntentsSummary {
  /** Mutations applied to the local catalogue. */
  applied: number;
  /** Everything refused or set aside — wrong-host envelopes, foreign rows, malformed shapes. */
  skipped: number;
  /** Human lines describing what happened, for the CLI to print. */
  readonly notes: string[];
}

/**
 * Apply edit-intent envelopes given as JSON lines (a pipeline/test surface — assumes every
 * envelope on stdin belongs to this Host's pass; the inbox form below is the fleet-correct one).
 */
export function applyIntents(
  catalogue: Database,
  lines: readonly string[],
  opts: ApplyIntentsOptions,
): ApplyIntentsSummary {
  const summary: ApplyIntentsSummary = { applied: 0, skipped: 0, notes: [] };
  for (const line of lines) {
    if (!line.trim()) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(line);
    } catch {
      summary.skipped++;
      summary.notes.push("unparseable line skipped");
      continue;
    }
    const id = (envelope as { id?: string })?.id ?? "?";
    const outcome = applyIntentEnvelope(catalogue, envelope, opts);
    recordOutcome(summary, id, outcome);
  }
  return summary;
}

function recordOutcome(summary: ApplyIntentsSummary, id: string, outcome: IntentOutcome): void {
  switch (outcome.kind) {
    case "applied":
      summary.applied += outcome.applied;
      summary.skipped += outcome.refused.length;
      summary.notes.push(
        `${id}: applied ${outcome.applied}` +
          (outcome.refused.length
            ? `, refused ${outcome.refused.length} (foreign rows: ${outcome.refused.map((m) => m.sessionId.slice(0, 8)).join(", ")})`
            : ""),
      );
      break;
    case "wrong-host":
      summary.skipped++;
      summary.notes.push(`${id}: addressed to ${outcome.host} — left for its Host`);
      break;
    case "malformed":
      summary.skipped++;
      summary.notes.push(`${id}: malformed (${outcome.reason})`);
      break;
    case "not-an-intent":
      break; // open vocabulary — silently not ours
  }
}

/**
 * The fleet-correct apply: walk the applier role's inbox (its state dir rides Sync, so every
 * Host sees the same files), consume ONLY envelopes addressed to this Host — apply, move to
 * inbox/processed/, ledger the id (mirroring `fleet drain --mark` for the consumed subset) —
 * and leave wrong-Host envelopes untouched for their own Host's pass. Malformed intents go to
 * dead-letter/ with a reason (protocol law 4: nothing vanishes silently). Mutation upserts are
 * idempotent, so a Sync race on the shared ledger degrades to a harmless reapply.
 */
export function applyIntentsFromInbox(
  catalogue: Database,
  stateDir: string,
  opts: ApplyIntentsOptions,
): ApplyIntentsSummary {
  const summary: ApplyIntentsSummary = { applied: 0, skipped: 0, notes: [] };
  const inbox = join(stateDir, "inbox");
  if (!existsSync(inbox)) {
    summary.notes.push(`no inbox at ${inbox}`);
    return summary;
  }
  const ledgerPath = join(stateDir, "processed-ids.log");
  const seen = new Set(
    existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8").split(/\s+/).filter(Boolean) : [],
  );
  const processedDir = join(inbox, "processed");
  const deadDir = join(stateDir, "dead-letter");

  const consume = (file: string, id: string): void => {
    mkdirSync(processedDir, { recursive: true });
    renameSync(join(inbox, file), join(processedDir, file));
    appendFileSync(ledgerPath, id + "\n");
  };

  for (const file of readdirSync(inbox).filter((f) => f.startsWith("msg-") && f.endsWith(".json")).sort()) {
    let envelope: unknown;
    try {
      envelope = JSON.parse(readFileSync(join(inbox, file), "utf8"));
    } catch {
      continue; // unreadable file: leave it — `fleet drain` dead-letters malformed envelopes
    }
    const id = (envelope as { id?: string })?.id;
    if (typeof id !== "string") continue; // ditto — the protocol CLI owns spine validation
    if (seen.has(id)) {
      consume(file, id); // duplicate delivery of a processed id — protocol law 3
      continue;
    }
    const outcome = applyIntentEnvelope(catalogue, envelope, opts);
    if (outcome.kind === "not-an-intent" || outcome.kind === "wrong-host") {
      if (outcome.kind === "wrong-host") summary.notes.push(`${id}: for ${outcome.host} — left in inbox`);
      continue; // not this Host's to consume
    }
    if (outcome.kind === "malformed") {
      mkdirSync(deadDir, { recursive: true });
      writeFileSync(
        join(deadDir, file),
        JSON.stringify({ reason: `edit-intent: ${outcome.reason}`, envelope }, null, 2) + "\n",
      );
      consume(file, id);
      recordOutcome(summary, id, outcome);
      continue;
    }
    // applied (possibly with refusals): refusals are set aside in dead-letter, not dropped —
    // the sender addressed them here, so no other Host will ever act on them.
    if (outcome.refused.length) {
      mkdirSync(deadDir, { recursive: true });
      writeFileSync(
        join(deadDir, file),
        JSON.stringify(
          { reason: "edit-intent mutations refused: rows owned elsewhere per merged view", refused: outcome.refused, envelope },
          null,
          2,
        ) + "\n",
      );
    }
    consume(file, id);
    seen.add(id);
    recordOutcome(summary, id, outcome);
  }
  return summary;
}
