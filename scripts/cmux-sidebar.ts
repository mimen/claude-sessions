#!/usr/bin/env bun
import {
  CCS_SIDEBAR_NAME,
  inspectCcsSidebar,
  installCcsSidebar,
} from "../src/cmux/sidebar.ts";

const usage = `Usage:
  bun run cmux:sidebar:install [--force]
  bun run cmux:sidebar:validate
  bun run cmux:sidebar:open
  bun run cmux:sidebar:select`;

type CmuxSidebarCommand = "validate" | "open" | "select";

function requireCurrentInstall(): boolean {
  const inspection = inspectCcsSidebar();
  if (!inspection.ok) {
    console.error(inspection.error.message);
    return false;
  }
  if (inspection.value.state === "missing") {
    console.error(`Sidebar is not installed at ${inspection.value.targetPath}. Run bun run cmux:sidebar:install first.`);
    return false;
  }
  if (inspection.value.state === "different") {
    console.error(`Installed sidebar differs from ${inspection.value.sourcePath}. Reconcile it before using this wrapper.`);
    return false;
  }
  return true;
}

function runCmux(command: CmuxSidebarCommand): number {
  if (!requireCurrentInstall()) return 1;
  try {
    const result = Bun.spawnSync(["cmux", "sidebar", command, CCS_SIDEBAR_NAME], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return result.exitCode;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.error(`Cannot run cmux sidebar ${command}: ${detail}`);
    return 1;
  }
}

function runInstall(args: readonly string[]): number {
  const unexpected = args.filter((arg) => arg !== "--force");
  if (unexpected.length > 0) {
    console.error(`Unknown install argument: ${unexpected[0]}`);
    console.error(usage);
    return 2;
  }

  const result = installCcsSidebar({ force: args.includes("--force") });
  if (!result.ok) {
    console.error(result.error.message);
    return result.error.code === "conflict" ? 2 : 1;
  }

  if (result.value.state === "installed") {
    console.log(`Installed ${result.value.sourcePath} → ${result.value.targetPath}`);
  } else if (result.value.state === "unchanged") {
    console.log(`Already current: ${result.value.targetPath}`);
  } else {
    console.log(`Installed ${result.value.sourcePath} → ${result.value.targetPath}`);
    console.log(`Previous sidebar preserved at ${result.value.backupPath}`);
  }
  return 0;
}

function main(args: readonly string[]): number {
  const [command, ...rest] = args;
  if (command === "install") return runInstall(rest);
  if (rest.length > 0) {
    console.error(`Unexpected arguments for ${command ?? "sidebar command"}: ${rest.join(" ")}`);
    console.error(usage);
    return 2;
  }
  if (command === "validate" || command === "open" || command === "select") {
    return runCmux(command);
  }
  console.error(usage);
  return 2;
}

process.exitCode = main(Bun.argv.slice(2));
