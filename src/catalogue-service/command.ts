import {
  getCatalogueHealth,
  refreshCatalogueAuthority,
  shutdownCatalogueService,
} from "./client.ts";
import { catalogueServicePaths, runCatalogueDaemon } from "./server.ts";

const USAGE = `usage:
  ccs catalogue-service start
  ccs catalogue-service status [--json]
  ccs catalogue-service stop
  ccs catalogue-service refresh [--titles] [--json]
  ccs catalogue-service serve [--idle-timeout-ms <ms>] [--fresh-ms <ms>]`;

function positiveFlag(args: readonly string[], name: string): number | undefined {
  const exact = args.indexOf(name);
  const raw = exact >= 0 ? args[exact + 1] : args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export async function catalogueServiceCommand(args: string[]): Promise<number> {
  const verb = args[0];
  switch (verb) {
    case "serve": {
      const result = await runCatalogueDaemon({
        idleTimeoutMs: positiveFlag(args, "--idle-timeout-ms"),
        freshMs: positiveFlag(args, "--fresh-ms"),
      });
      if (result.status === "failed") {
        console.error(`ccs: ${result.message}`);
        return 1;
      }
      if (result.status === "already-running") {
        console.log(`ccs: catalogue service already running${result.pid ? ` (pid ${result.pid})` : ""}`);
      }
      return 0;
    }
    case "start": {
      const health = await getCatalogueHealth(true);
      if (!health.ok) {
        console.error(`ccs: ${health.error.message}`);
        return 1;
      }
      console.log(`ccs: catalogue service running (pid ${health.value.service.pid})`);
      return 0;
    }
    case "status": {
      const health = await getCatalogueHealth(false);
      if (!health.ok) {
        if (args.includes("--json")) {
          console.log(JSON.stringify({ running: false, ...catalogueServicePaths() }));
        } else {
          console.log("ccs: catalogue service stopped");
        }
        return 1;
      }
      if (args.includes("--json")) {
        console.log(JSON.stringify({ running: true, ...health.value, ...catalogueServicePaths() }));
      } else {
        const status = health.value.sourceStatus;
        console.log(
          `ccs: catalogue service running (pid ${health.value.service.pid}) · ` +
          `generation ${status.generation} · ${status.freshness} · ${status.rowCount} roots`,
        );
      }
      return 0;
    }
    case "refresh": {
      const result = await refreshCatalogueAuthority({ force: true, titles: args.includes("--titles") });
      if (!result.ok) {
        console.error(`ccs: ${result.error.message}`);
        return 1;
      }
      if (args.includes("--json")) {
        console.log(JSON.stringify(result.value));
      } else {
        console.log(
          `ccs: catalogue generation ${result.value.sourceStatus.generation} · ` +
          `${result.value.stats.parsed} parsed, ${result.value.stats.skipped} unchanged, ` +
          `${result.value.stats.removed} removed`,
        );
      }
      return 0;
    }
    case "stop": {
      const result = await shutdownCatalogueService();
      if (!result.ok) {
        if (result.error.code === "unavailable") {
          console.log("ccs: catalogue service already stopped");
          return 0;
        }
        console.error(`ccs: ${result.error.message}`);
        return 1;
      }
      console.log("ccs: catalogue service stopping");
      return 0;
    }
    default:
      console.error(USAGE);
      return 1;
  }
}
