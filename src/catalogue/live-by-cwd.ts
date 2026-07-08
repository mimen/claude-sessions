import { execFileSync } from "node:child_process";

/**
 * Derive which session cwds are currently OPEN in cmux by matching cmux workspace current_directory
 * against session cwds. This is STABLE (cwd doesn't change when a pane reattaches), unlike title/tty.
 *
 * Returns a set of absolute cwd paths that have live cmux workspaces. Returns empty when cmux
 * isn't reachable (caller treats "unknown" as "not open" — safe for idempotency).
 */
export function liveByCwd(cmuxBin = "cmux"): Set<string> {
  let out: string;
  try {
    out = execFileSync(cmuxBin, ["tree", "--all", "--json"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return new Set(); // cmux not running / not reachable
  }

  try {
    const tree = JSON.parse(out) as {
      windows?: { workspaces?: { current_directory?: string }[] }[];
    };
    const cwds = new Set<string>();
    for (const win of tree.windows ?? []) {
      for (const w of win.workspaces ?? []) {
        if (w.current_directory) cwds.add(w.current_directory);
      }
    }
    return cwds;
  } catch {
    return new Set(); // parse failure
  }
}
