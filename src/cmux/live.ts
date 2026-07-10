/**
 * Live I/O for the cmux bridge: shell out to `cmux tree --all` and read cmux's persisted
 * state file, then hand both to buildBridge. Kept separate from bridge.ts so the parsing /
 * resolution logic stays pure + fixture-tested (bridge.test.ts) and this thin layer owns the
 * side effects.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildBridge,
  type Bridge,
  type CmuxPersisted,
  type CmuxTree,
} from "./bridge";

const PERSISTED_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "cmux",
  "session-com.cmuxterm.app.json",
);

/** Enumerate every window (ADR-0016): `--all` is required or the current window only. */
function readTree(): CmuxTree {
  try {
    const out = execFileSync(
      "cmux",
      ["tree", "--all", "--json", "--id-format", "both"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out) as CmuxTree;
  } catch {
    return { windows: [] }; // cmux not running / not installed -> nothing live
  }
}

function readPersisted(): CmuxPersisted {
  try {
    return JSON.parse(readFileSync(PERSISTED_PATH, "utf8")) as CmuxPersisted;
  } catch {
    return { windows: [] };
  }
}

/** Build a bridge from the live cmux state on this machine. */
export function liveBridge(): Bridge {
  return buildBridge(readTree(), readPersisted());
}
