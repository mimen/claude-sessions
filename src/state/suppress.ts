/**
 * `ccs suppress` — the decision-suppression ledger, cluster-scoped.
 *
 * A cluster surfaces items (a decision to make, a drafted reply, a fix to accept). When Milad
 * (relayed by the concierge) or the orchestrator DECIDES an item, its disposition is recorded
 * against a stable item key so the item stops re-surfacing on every rebuild — even after a
 * worker restart.
 *
 * Dispositions:
 *   clear    — handled/dismissed; suppress forever.
 *   approve  — approved (a drafted reply was sent); suppress forever.
 *   hold     — deliberately parked; suppress until explicitly re-opened.
 *   defer    — suppress UNTIL an ISO timestamp; re-surfaces after it passes.
 *
 * Storage: raw {key: entry} JSON at ~/.ccs/clusters/<cluster>/cluster/dispositions.json —
 * the SAME format the cluster's engine-lib reads on every tick (drain_events, slack_scout).
 * Atomic temp+rename write, so cluster python + tool TypeScript can share the file.
 *
 * The item key is `<work-unit>::<kind>::<id>` — the producer (drain) and the decider (the
 * concierge, via this CLI) build it the same way so they always agree. `--now` is caller-
 * supplied (determinism rule: no clock calls inside the module).
 *
 * Usage:
 *   ccs suppress <cluster> record <work-unit> <kind> <id> <clear|approve|hold|defer>
 *                          --now <iso> [--note "..."] [--until <iso>]  (until required for defer)
 *   ccs suppress <cluster> reopen <work-unit> <kind> <id>            # un-suppress
 *   ccs suppress <cluster> check  <work-unit> <kind> <id> --now <iso># exit 0 = suppressed, 1 = not
 *   ccs suppress <cluster> list                                       # dump the ledger
 *
 * `kind` is any short tag the cluster chooses (decision|reply|fix in pr-watch); we don't
 * enforce a vocabulary here so a second cluster with different item kinds can use this
 * unchanged.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { runtimeRoot } from "../paths.ts";

const LEDGER = "dispositions.json";
const SUPPRESS_FOREVER = new Set(["clear", "approve", "hold"]);
const VALID = new Set([...SUPPRESS_FOREVER, "defer"]);

interface Entry {
  disposition: string;
  at: string;
  note?: string;
  until?: string;
}

function ledgerPath(cluster: string): string {
  return join(runtimeRoot(), "clusters", cluster, "cluster", LEDGER);
}

function itemKey(workUnit: string, kind: string, id: string): string {
  return `${workUnit}::${kind}::${id}`;
}

function load(path: string): Record<string, Entry> {
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, Entry>)
      : {};
  } catch {
    return {};
  }
}

function writeAtomic(path: string, data: Record<string, Entry>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${dirname(path)}/.${LEDGER}.tmp`;
  // Sort top-level keys so the file diffs cleanly across writes. Nested entry fields keep
  // their natural insertion order (disposition, at, note?, until?).
  const sorted: Record<string, Entry> = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k]!;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`);
  renameSync(tmp, path);
}

function isSuppressed(entry: Entry | undefined, now: string): boolean {
  if (!entry) return false;
  if (SUPPRESS_FOREVER.has(entry.disposition)) return true;
  if (entry.disposition === "defer" && entry.until) {
    // ISO8601 in a fixed offset sorts lexically.
    return now < entry.until;
  }
  return false;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) { i++; continue; } // skip flag + its value
    out.push(a);
  }
  return out;
}

export function suppressCommand(args: string[]): number {
  const pos = positional(args);
  const cluster = pos[0];
  const sub = pos[1];
  if (!cluster || !sub) {
    console.error(
      "usage: ccs suppress <cluster> record|reopen|check|list ...",
    );
    return 2;
  }
  const path = ledgerPath(cluster);

  if (sub === "record") {
    const [workUnit, kind, id, disp] = [pos[2], pos[3], pos[4], pos[5]];
    const now = flag(args, "--now");
    const note = flag(args, "--note");
    const until = flag(args, "--until");
    if (!workUnit || !kind || !id || !disp) {
      console.error("usage: ccs suppress <cluster> record <work-unit> <kind> <id> <clear|approve|hold|defer> --now <iso> [--note ...] [--until <iso>]");
      return 2;
    }
    if (!VALID.has(disp)) {
      console.error(`unknown disposition ${disp} (valid: ${[...VALID].sort().join(", ")})`);
      return 2;
    }
    if (!now) {
      console.error("record: --now <iso> is required");
      return 2;
    }
    if (disp === "defer" && !until) {
      console.error("defer requires --until <iso>");
      return 2;
    }
    const data = load(path);
    const entry: Entry = { disposition: disp, at: now };
    if (note) entry.note = note;
    if (until) entry.until = until;
    const key = itemKey(workUnit, kind, id);
    data[key] = entry;
    writeAtomic(path, data);
    console.log(JSON.stringify({ key, ...entry }));
    return 0;
  }

  if (sub === "reopen") {
    const [workUnit, kind, id] = [pos[2], pos[3], pos[4]];
    if (!workUnit || !kind || !id) {
      console.error("usage: ccs suppress <cluster> reopen <work-unit> <kind> <id>");
      return 2;
    }
    const data = load(path);
    const key = itemKey(workUnit, kind, id);
    const existed = key in data;
    if (existed) {
      delete data[key];
      writeAtomic(path, data);
    }
    console.log(JSON.stringify({ key, reopened: existed }));
    return 0;
  }

  if (sub === "check") {
    const [workUnit, kind, id] = [pos[2], pos[3], pos[4]];
    const now = flag(args, "--now");
    if (!workUnit || !kind || !id || !now) {
      console.error("usage: ccs suppress <cluster> check <work-unit> <kind> <id> --now <iso>");
      return 2;
    }
    const entry = load(path)[itemKey(workUnit, kind, id)];
    return isSuppressed(entry, now) ? 0 : 1;
  }

  if (sub === "list") {
    console.log(JSON.stringify(load(path), null, 2));
    return 0;
  }

  console.error(`unknown subcommand: ${sub}`);
  return 2;
}
