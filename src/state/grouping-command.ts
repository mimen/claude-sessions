/**
 * `ccs grouping` — a cluster ADAPTER's write path for grouping (epic) display metadata + notes
 * (ADR-0051). The grouping's name/link/shortname are SENSED from the cluster's tracker (GUS for
 * pr-watch) and its notes ACCUMULATE as agents learn — both are cluster runtime state, so the
 * cluster's sensor writes them through ccs rather than a hardcoded platform table.
 *
 *   ccs grouping set  --cluster <c> <id> --label <text> [--url <u>] [--short <s>] [--from <who>]
 *   ccs grouping note --cluster <c> <id> --note "<text>" [--from <who>]
 *   ccs grouping get  --cluster <c> <id>
 */
import { getGrouping, upsertGrouping, appendGroupingNote, deriveShortName } from "./groupings.ts";

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}
/** The doc id/name = the first positional that is NOT a flag nor a flag's value. */
function positionalId(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) { i++; continue; }
    return a;
  }
  return undefined;
}

export function groupingCommand(args: string[]): number {
  const sub = args[0];
  const cluster = flag(args, "--cluster");
  const id = positionalId(args);
  if (!cluster) {
    console.error("ccs grouping: --cluster <c> required");
    return 1;
  }
  if (!id) {
    console.error("ccs grouping: missing grouping id (e.g. an epic id)");
    return 1;
  }
  const source = flag(args, "--from") ?? "cli";

  switch (sub) {
    case "set": {
      const label = flag(args, "--label") ?? null;
      const url = flag(args, "--url") ?? null;
      // shortName precedence: explicit --short wins (a human display choice). Otherwise KEEP an
      // existing shortName — a sensor re-running `set --label …` each tick must NOT clobber a
      // manually-set short (the "PP→Dashboard reverts to the mangled derive every tick" bug). Only
      // DERIVE from the label when there's no short yet (first sense of a new grouping).
      const explicitShort = flag(args, "--short");
      const existing = getGrouping(cluster, id)?.shortName ?? null;
      const shortName = explicitShort ?? existing ?? deriveShortName(label);
      upsertGrouping(cluster, id, { label, url, shortName }, now(), source);
      console.log(JSON.stringify({ status: "OK", id, cluster }));
      return 0;
    }
    case "note": {
      const note = flag(args, "--note");
      if (!note) {
        console.error('ccs grouping note --cluster <c> <id> --note "<text>"');
        return 1;
      }
      appendGroupingNote(cluster, id, note, now(), source);
      console.log(JSON.stringify({ status: "OK", id, cluster }));
      return 0;
    }
    case "get": {
      const g = getGrouping(cluster, id);
      console.log(g ? JSON.stringify(g) : "null");
      return 0;
    }
    default:
      console.error(`ccs grouping: unknown subcommand "${sub}" (set | note | get)`);
      return 1;
  }
}
