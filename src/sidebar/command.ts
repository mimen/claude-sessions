/**
 * `ccs sidebar` — run the productivity sidebar's local web host.
 *
 * The port is fixed by default so the cmux Dock can hold a stable URL across restarts.
 */
import { buildSidebarAssets } from "./bundle.ts";
import {
  createSidebarServer,
  DEFAULT_SIDEBAR_HOST,
  DEFAULT_SIDEBAR_PORT,
  isLoopbackSidebarHost,
} from "./server.ts";
import { createSidebarSource } from "./snapshot.ts";
import { subscribeToCmuxEvents } from "../cmux/events.ts";

const HELP = `ccs sidebar — the productivity sidebar's local web host

Usage:
  ccs sidebar serve [--port <n>] [--host <loopback>]   Serve the sidebar (default 127.0.0.1:${DEFAULT_SIDEBAR_PORT})
  ccs sidebar url                                      Print the URL to open in the cmux Dock

Security:
  --host accepts only literal loopback addresses: 127.0.0.0/8 or ::1. All other binds are refused.
`;

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function resolvePort(args: readonly string[]): number | { error: string } {
  const raw = flagValue(args, "--port");
  if (raw === undefined) return DEFAULT_SIDEBAR_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { error: `--port expects a port number, got ${JSON.stringify(raw)}` };
  }
  return port;
}

function sidebarUrl(host: string, port: number): string {
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  return `http://${formattedHost}:${port}/`;
}

export async function sidebarCommand(args: readonly string[]): Promise<number> {
  const subcommand = args[0] ?? "serve";
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(HELP);
    return 0;
  }

  const port = resolvePort(args);
  if (typeof port !== "number") {
    console.error(port.error);
    return 1;
  }
  const host = flagValue(args, "--host") ?? DEFAULT_SIDEBAR_HOST;
  if (!isLoopbackSidebarHost(host)) {
    console.error(
      `--host must be a literal loopback address (127.0.0.0/8 or ::1), got ${JSON.stringify(host)}`,
    );
    return 1;
  }

  if (subcommand === "url") {
    console.log(sidebarUrl(host, port));
    return 0;
  }

  if (subcommand !== "serve") {
    console.error(`unknown sidebar subcommand: ${subcommand}\n\n${HELP}`);
    return 1;
  }

  const assets = await buildSidebarAssets();
  if (!assets.ok) {
    console.error(assets.error.message);
    return 1;
  }

  try {
    const source = createSidebarSource();
    // Only the long-lived server follows cmux. A source built for a one-shot command has no use
    // for a subscription that outlives the answer, and would leave a child process behind.
    subscribeToCmuxEvents({ onChange: (scopes) => source.invalidate?.(scopes) });
    const server = createSidebarServer({
      source,
      assets: assets.value,
      port,
      hostname: host,
    });
    console.log(`ccs sidebar listening on ${server.url.href}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`could not listen on ${host}:${port} — ${message}`);
    return 1;
  }

  // Serve until interrupted; Bun keeps the process alive while the server is listening.
  await new Promise<void>(() => {});
  return 0;
}
