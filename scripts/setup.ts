#!/usr/bin/env bun
import { $ } from "bun";

/** One-shot onboarding: link `ccs` onto PATH and report on optional dependencies. */

function has(bin: string): boolean {
  try {
    return Bun.spawnSync(["which", bin], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } catch {
    return false;
  }
}

console.log("Setting up claude-sessions (ccs)…\n");

try {
  await $`bun link`.quiet();
  console.log("✓ linked — `ccs` is on your PATH (via bun link)");
} catch {
  console.log("✗ `bun link` failed. Run it manually in this directory, or add bin/ccs to your PATH.");
}

console.log("\nDependency check:");
const deps: Array<[string, string]> = [
  ["claude", "required — resume launches `claude --resume`"],
  ["codex", "optional — generates titles for sessions Claude Code didn't title"],
  ["cmux", "optional — resume opens a named cmux workspace when reachable"],
];
for (const [bin, why] of deps) {
  console.log(`  ${has(bin) ? "✓" : "✗"} ${bin.padEnd(7)} ${why}`);
}

console.log("\nNext: run `ccs` to browse and resume your sessions.");
console.log("Tip: `ccs reindex --titles` (cron-friendly) pre-builds the index + titles.");
