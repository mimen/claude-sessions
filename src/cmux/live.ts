/**
 * Live I/O for the cmux bridge: shell out to `cmux tree --all` and read cmux's 0.64 hook store
 * (`~/.cmuxterm/claude-hook-sessions.json`), then hand both to buildBridge. Kept separate from
 * bridge.ts so the parsing / resolution logic stays pure + fixture-tested (bridge.test.ts) and
 * this thin layer owns the side effects.
 *
 * READABILITY is a first-class result here (ADR-0054): a bridge built from sources we could not
 * read is NOT the same as "nothing is open". `readable` is true only if BOTH the tree command
 * succeeded AND the hook store was present+parseable. A missing store file is treated as
 * readable-but-empty (cmux installed, just no tracked sessions yet); a failed `cmux tree`
 * (binary absent, socket unauthed, non-zero exit) is UNREADABLE. Resume fails closed on it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildBridge,
  type Bridge,
  type CmuxHookStore,
  type CmuxTree,
} from "./bridge";

const HOOK_STORE_PATH = join(
  homedir(),
  ".cmuxterm",
  "claude-hook-sessions.json",
);

/** Enumerate every window (ADR-0016): `--all` is required or the current window only. */
function readTree(): { tree: CmuxTree; ok: boolean } {
  try {
    const out = execFileSync(
      "cmux",
      ["tree", "--all", "--json", "--id-format", "both"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { tree: JSON.parse(out) as CmuxTree, ok: true };
  } catch {
    return { tree: { windows: [] }, ok: false }; // cmux down / unauthed -> UNREADABLE
  }
}

/**
 * Read the hook store. A missing file is readable-but-empty (cmux is installed, no sessions
 * tracked yet); a present-but-unparseable file is UNREADABLE (don't guess it's empty).
 */
function readHookStore(): { store: CmuxHookStore; ok: boolean } {
  if (!existsSync(HOOK_STORE_PATH)) return { store: {}, ok: true };
  try {
    return { store: JSON.parse(readFileSync(HOOK_STORE_PATH, "utf8")) as CmuxHookStore, ok: true };
  } catch {
    return { store: {}, ok: false };
  }
}

/** Build a bridge from the live cmux state on this machine. */
export function liveBridge(): Bridge {
  const { tree, ok: treeOk } = readTree();
  const { store, ok: storeOk } = readHookStore();
  return buildBridge(tree, store, treeOk && storeOk);
}
