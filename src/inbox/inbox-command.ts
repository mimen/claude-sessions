/**
 * `ccs inbox send|drain|pending` — the cluster-agnostic durable messaging primitive
 * (ADR-0023/0033). Any system delivers to / drains an identity's inbox by its RESPONSIBILITY
 * (--cluster/--role/--epic/--work-unit), which resolves to a dir under ~/.ccs (ADR-0041).
 */
import { ccsRuntimeRoot, identityDir, type Responsibility } from "./identity-path.ts";
import { writeMessage, drain, pendingMessages } from "./inbox.ts";

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : undefined;
}

function responsibilityFrom(args: string[]): Responsibility | null {
  const role = flag(args, "--role");
  if (!role) return null;
  return {
    cluster: flag(args, "--cluster") ?? null,
    role,
    epic: flag(args, "--epic") ?? null,
    workUnit: flag(args, "--work-unit") ?? null,
  };
}

export function inboxCommand(args: string[]): number {
  const sub = args[0];
  const resp = responsibilityFrom(args);
  if (!resp) {
    console.error("ccs inbox: --role is required (plus optional --cluster/--epic/--work-unit)");
    return 1;
  }
  const dir = identityDir(ccsRuntimeRoot(), resp);

  switch (sub) {
    case "send": {
      const from = flag(args, "--from");
      const message = flag(args, "--message");
      if (!from || !message) {
        console.error('ccs inbox send --role <r> [--cluster …] --from <sender> --message "<text>"');
        return 1;
      }
      const path = writeMessage(dir, from, message, stamp());
      console.log(JSON.stringify({ status: "OK", path }));
      return 0;
    }
    case "drain": {
      const msgs = drain(dir);
      console.log(
        JSON.stringify({
          status: "OK",
          count: msgs.length,
          messages: msgs.map((m) => ({ path: m.path, sender: m.sender, body: m.body })),
        }),
      );
      return 0;
    }
    case "pending": {
      const paths = pendingMessages(dir);
      console.log(JSON.stringify({ status: "OK", count: paths.length, pending: paths }));
      return 0;
    }
    default:
      console.error(`ccs inbox: unknown subcommand "${sub}" (send | drain | pending)`);
      return 1;
  }
}
