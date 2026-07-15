/**
 * `ccs state get` — read-only access to the durable-state store (ADR-0025/0031, narrowed by
 * ADR-0089). Writes are the engine's job (sensors + `ccs identity/session/inbox`), never
 * this command; the pre-refactor `set`/`merge` verbs had zero external callers so they were
 * removed. Reading is still useful for debugging: `ccs state get --cluster pr-watch board`
 * unwraps the envelope and prints the sensor's payload.
 *
 *   ccs state get --cluster <c> <name>          -> JSON doc (or null)
 *   ccs state get --role <r> [--epic e] [--work-unit w] <name>
 */
import { ccsRuntimeRoot, type Responsibility } from "../inbox/identity-path.ts";
import { readClusterDoc, readIdentityDoc } from "./cluster-state.ts";

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
    return {
      kind: "identity",
      r: {
        cluster: cluster ?? null,
        role,
        epic: flag(args, "--epic") ?? null,
        workUnit: flag(args, "--work-unit") ?? null,
      },
    };
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
  if (sub !== "get") {
    console.error(
      `ccs state: only 'get' is supported (ADR-0089 narrowing).\n` +
      `  Writes go through ccs identity/session/inbox — sensors bypass this command entirely.`,
    );
    return 1;
  }
  const name = positionalName(args);
  const scope = scopeOf(args);
  if (!scope) {
    console.error("ccs state get: need --cluster <c> (cluster-scoped) or --role <r> (identity-scoped)");
    return 1;
  }
  if (!name) {
    console.error("ccs state get: missing doc name (e.g. board, gate, result)");
    return 1;
  }
  const root = ccsRuntimeRoot();
  const doc = scope.kind === "cluster"
    ? readClusterDoc(root, scope.cluster, name)
    : readIdentityDoc(root, scope.r, name);
  console.log(doc ? JSON.stringify(doc) : "null");
  return 0;
}
