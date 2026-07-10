/**
 * `ccs state` — CLI access to the durable-state store (ADR-0025/0031), so any system
 * (pr-watch's python/bash) reads + writes cluster- and identity-scoped state through ccs
 * instead of a private dir.
 *
 *   ccs state get   --cluster <c> <name>                 -> JSON doc (or null)
 *   ccs state set   --cluster <c> <name> --json '<...>'  (whole-doc write)
 *   ccs state merge --cluster <c> <name> --json '<...>'  (single-writer-per-field)
 *   ...same with --role <r> [--epic e] [--work-unit w] for identity-scoped state
 * --source <who> stamps the writer (defaults to "cli").
 */
import { ccsRuntimeRoot, type Responsibility } from "../inbox/identity-path.ts";
import {
  readClusterDoc,
  writeClusterDoc,
  mergeClusterDoc,
  readIdentityDoc,
  writeIdentityDoc,
  mergeIdentityDoc,
} from "./cluster-state.ts";

function now(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

/** cluster-scoped iff --cluster given AND no --role; identity-scoped iff --role given. */
function scopeOf(args: string[]): { kind: "cluster"; cluster: string } | { kind: "identity"; r: Responsibility } | null {
  const role = flag(args, "--role");
  const cluster = flag(args, "--cluster");
  if (role) {
    return { kind: "identity", r: { cluster: cluster ?? null, role, epic: flag(args, "--epic") ?? null, workUnit: flag(args, "--work-unit") ?? null } };
  }
  if (cluster) return { kind: "cluster", cluster };
  return null;
}

/** The doc name = the first positional that is NOT a flag NOR a flag's value. */
function positionalName(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      i++; // skip this flag's value (all our flags take one)
      continue;
    }
    return a;
  }
  return undefined;
}

export function stateCommand(args: string[]): number {
  const sub = args[0];
  const name = positionalName(args);
  const scope = scopeOf(args);
  if (!scope) {
    console.error("ccs state: need --cluster <c> (cluster-scoped) or --role <r> (identity-scoped)");
    return 1;
  }
  if (!name) {
    console.error("ccs state: missing doc name (e.g. board, gate, result)");
    return 1;
  }
  const root = ccsRuntimeRoot();
  const source = flag(args, "--source") ?? "cli";

  const read = () =>
    scope.kind === "cluster" ? readClusterDoc(root, scope.cluster, name) : readIdentityDoc(root, scope.r, name);

  switch (sub) {
    case "get": {
      const doc = read();
      console.log(doc ? JSON.stringify(doc) : "null");
      return 0;
    }
    case "set":
    case "merge": {
      const raw = flag(args, "--json");
      if (!raw) {
        console.error(`ccs state ${sub}: --json '<object>' required`);
        return 1;
      }
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(raw);
      } catch {
        console.error("ccs state: --json is not valid JSON");
        return 1;
      }
      const opts = { now: now(), source };
      if (sub === "set") {
        scope.kind === "cluster"
          ? writeClusterDoc(root, scope.cluster, name, obj, opts)
          : writeIdentityDoc(root, scope.r, name, obj, opts);
      } else {
        scope.kind === "cluster"
          ? mergeClusterDoc(root, scope.cluster, name, obj, opts)
          : mergeIdentityDoc(root, scope.r, name, obj, opts);
      }
      console.log(JSON.stringify({ status: "OK", name, scope: scope.kind }));
      return 0;
    }
    default:
      console.error(`ccs state: unknown subcommand "${sub}" (get | set | merge)`);
      return 1;
  }
}
