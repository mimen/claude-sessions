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
import { startSidebarChangeMonitor } from "./change-monitor.ts";
import { createSidebarSource } from "./snapshot.ts";
import { syncT3Associations } from "../t3/association-sync.ts";

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

function waitForTermination(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
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
    // Positive T3 provenance is durable. Observe immediately after binding, then at a slow cadence;
    // optional enrichment must never delay or prevent the sidebar from serving existing state.
    const source = createSidebarSource();
    let t3SyncFlight: Promise<void> | null = null;
    const syncT3 = (): void => {
      if (t3SyncFlight) return;
      t3SyncFlight = syncT3Associations()
        .then((result) => {
          if (result.tagged > 0) source.reconcileDurableState?.();
        })
        .catch(() => undefined)
        .finally(() => { t3SyncFlight = null; });
    };
    const server = createSidebarServer({
      source,
      assets: assets.value,
      port,
      hostname: host,
    });
    // Only the resident server observes change. One-shot sources remain free of child processes,
    // timers and database probes that would outlive their answer.
    const changes = startSidebarChangeMonitor({ source });
    syncT3();
    const t3SyncTimer = setInterval(syncT3, 30_000);
    try {
      console.log(`ccs sidebar listening on ${server.url.href}`);
      // Serve until interrupted, then release the cmux child, timer, database handles and socket.
      await waitForTermination();
    } finally {
      clearInterval(t3SyncTimer);
      changes.stop();
      source.close?.();
      server.stop(true);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`could not start sidebar on ${host}:${port} — ${message}`);
    return 1;
  }
}
