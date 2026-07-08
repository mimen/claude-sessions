import { execFileSync } from "node:child_process";

/**
 * Derive which session cwds are currently OPEN in cmux by matching cmux workspace current_directory
 * against session cwds. This is STABLE (cwd doesn't change when a pane reattaches), unlike title/tty.
 *
 * Returns a set of absolute cwd paths that have live cmux workspaces. Returns empty when cmux
 * isn't reachable (caller treats "unknown" as "not open" — safe for idempotency).
 */
export function liveByCwd(cmuxBin = "cmux"): Set<string> {
  // Use `list-workspaces --json` — it carries `current_directory` per workspace.
  // (`tree --json` does NOT expose the directory, only titles/panes; using it made
  // liveByCwd always empty, so resume was never idempotent and spawned duplicate
  // panes on every run — caught go-live 2026-07-08.)
  let out: string;
  try {
    out = execFileSync(cmuxBin, ["list-workspaces", "--json"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Set(); // cmux not running / not reachable
  }

  try {
    const parsed = JSON.parse(out) as
      | { workspaces?: { current_directory?: string }[] }
      | { current_directory?: string }[];
    const list = Array.isArray(parsed) ? parsed : parsed.workspaces ?? [];
    const cwds = new Set<string>();
    for (const w of list) {
      if (w.current_directory) cwds.add(w.current_directory);
    }
    return cwds;
  } catch {
    return new Set(); // parse failure
  }
}
