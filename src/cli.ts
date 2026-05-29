import pkg from "../package.json" with { type: "json" };
import { loadConfig } from "./config.ts";
import { scanStore, formatBytes } from "./store.ts";
import { ensureDataDir } from "./paths.ts";

const HELP = `ccs — find and resume any Claude Code session

Usage:
  ccs                 Launch the session browser (TUI)
  ccs reindex         Refresh the session index from the store
  ccs reindex --titles   Also (re)generate titles, headless (cron-friendly)
  ccs --version       Print version
  ccs --help          Show this help
`;

/** Entry point. Routes argv to a command; returns a process exit code. */
export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(pkg.version);
    return 0;
  }
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(HELP);
    return 0;
  }

  const command = args[0];

  switch (command) {
    case "reindex":
      return reindex({ titles: args.includes("--titles") });
    case undefined:
      // Bare `ccs` → TUI. Stubbed until Milestone 4.
      console.log("The session browser (TUI) arrives in Milestone 4.");
      console.log("For now, try `ccs reindex`.");
      return 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(HELP);
      return 1;
  }
}

/**
 * Milestone 1 reindex: discover Session files and report what's there.
 * Index population (SQLite) and title backfill land in Milestones 2-3.
 */
function reindex(opts: { titles: boolean }): number {
  ensureDataDir();

  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(configResult.error.message);
    return 1;
  }
  const config = configResult.value;

  const scanResult = scanStore(config.store.path);
  if (!scanResult.ok) {
    console.error(scanResult.error.message);
    return 1;
  }
  const files = scanResult.value;

  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  console.log(
    `Found ${files.length} session${files.length === 1 ? "" : "s"} ` +
      `(${formatBytes(totalBytes)}) in ${config.store.path} ` +
      `[host: ${config.host.label}]`,
  );

  if (opts.titles) {
    console.log("Title generation arrives in Milestone 3.");
  }
  return 0;
}
