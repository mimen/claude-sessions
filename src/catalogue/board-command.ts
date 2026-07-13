/**
 * `ccs board <cluster> [--json|--text]` — cluster-composed per-worker truth view.
 *
 * The TOOL owns the *dispatch mechanism* (find the cluster's board composer, exec it, stream its
 * output). The CLUSTER owns the *policy* (what a "row" means, what checks compose into a truth
 * label, per-role vocabulary). Per ADR-0061: tool = mechanism, cluster = policy.
 *
 * Resolution: `<ccsConfigRoot>/clusters/<cluster>/board` (executable) is preferred; falls back to
 * `<ccsConfigRoot>/clusters/<cluster>/engine/scripts/board.py` invoked with python3 for the
 * pr-watch-shaped cluster. Composer is invoked with:
 *   argv[1] = cluster state dir ($HOME/.ccs/clusters/<cluster>/cluster)
 *   argv[2] = "--json" or "--text" (passed through from the CLI, default --text)
 * stdout streams to our stdout; exit code passes through. Everything else is best-effort.
 *
 * Determinism guarantee: this command is pure dispatch. If the composer is missing / non-exec /
 * exits non-zero, we surface a clear error and return the composer's exit code. We never invent
 * a row.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ccsConfigRoot } from "../roles/role-files.ts";

interface Resolved {
  argv0: string;
  args: string[];
}

/** Find the composer for a cluster. Prefer a `board` executable at the cluster root; fall back
 * to `engine/scripts/board.py` invoked via python3 (the pr-watch shape). Returns null when no
 * composer exists — the caller surfaces a clear error rather than inventing a board. */
function resolveComposer(cluster: string): Resolved | null {
  const root = join(ccsConfigRoot(), "clusters", cluster);
  const direct = join(root, "board");
  if (existsSync(direct)) {
    try {
      const s = statSync(direct);
      // eslint-disable-next-line no-bitwise
      if (s.isFile() && (s.mode & 0o111) !== 0) return { argv0: direct, args: [] };
    } catch { /* fall through */ }
  }
  const pyFallback = join(root, "engine", "scripts", "board.py");
  if (existsSync(pyFallback)) return { argv0: "python3", args: [pyFallback] };
  return null;
}

export function boardCommand(args: string[]): number {
  const cluster = args.find((a) => !a.startsWith("--"));
  if (!cluster) {
    console.error("usage: ccs board <cluster> [--json|--text]");
    return 1;
  }
  const format = args.includes("--json") ? "--json" : args.includes("--text") ? "--text" : "--text";
  const composer = resolveComposer(cluster);
  if (!composer) {
    console.error(
      `ccs board: cluster "${cluster}" has no board composer. ` +
        `Expected an executable at \`clusters/${cluster}/board\` or a script at ` +
        `\`clusters/${cluster}/engine/scripts/board.py\`.`,
    );
    return 1;
  }
  const stateDir = join(process.env.HOME ?? "", ".ccs", "clusters", cluster, "cluster");
  const r = spawnSync(composer.argv0, [...composer.args, stateDir, format], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  return r.status ?? 1;
}
