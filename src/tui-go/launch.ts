/**
 * Launches the Go TUI (`tui-go/`), which is the default `ccs` interface.
 *
 * The binary is built on demand and cached at `tui-go/.bin/ccs-go`: a rebuild
 * happens only when a Go source file is newer than the binary, so the common
 * launch costs one directory sweep. If a rebuild fails we still run the previous
 * good binary — a broken working tree must never leave you without a session
 * browser.
 *
 * Returns null when the Go TUI can't run at all, so the caller can fall back to
 * the classic Ink TUI.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** Repo root, derived from this file's location (src/tui-go → ../..). */
function repoRoot(): string {
  return dirname(dirname(import.meta.dir));
}

function goDir(): string {
  return join(repoRoot(), "tui-go");
}

function binaryPath(): string {
  return join(goDir(), ".bin", "ccs-go");
}

/** Newest mtime across Go sources; decides whether a rebuild is needed. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip VCS, build output, and captured screenshots.
      if (entry.name === ".git" || entry.name === ".bin" || entry.name === "shots") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const relevant = entry.name.endsWith(".go") || entry.name === "go.mod" || entry.name === "go.sum";
      if (!relevant) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        /* an unreadable file can't invalidate the build */
      }
    }
  };
  walk(dir);
  return newest;
}

function goBinary(): string | null {
  const probe = spawnSync("sh", ["-lc", "command -v go"], { encoding: "utf8" });
  const found = probe.stdout?.trim();
  return found ? found : null;
}

/** Build the Go TUI. Returns an error string on failure, null on success. */
function build(): string | null {
  const go = goBinary();
  if (!go) return "go toolchain not found on PATH";
  const result = spawnSync(go, ["build", "-o", binaryPath(), "."], {
    cwd: goDir(),
    encoding: "utf8",
  });
  if (result.status === 0) return null;
  return (result.stderr || result.stdout || "go build failed").trim();
}

/** Run the Go TUI; returns its exit code, or null if it couldn't be run. */
export function launchGoTui(args: string[] = []): number | null {
  if (!existsSync(goDir())) return null;

  const binary = binaryPath();
  const haveBinary = existsSync(binary);
  const stale = !haveBinary || newestSourceMtime(goDir()) > statSync(binary).mtimeMs;

  if (stale) {
    const failure = build();
    if (failure && !existsSync(binary)) {
      console.error(`ccs: could not build the Go TUI — ${failure}`);
      return null;
    }
    if (failure) {
      console.error("ccs: Go TUI rebuild failed; running the previous build");
      console.error(failure);
    }
  }

  const run = spawnSync(binary, args, { stdio: "inherit" });
  if (run.error) {
    console.error(`ccs: could not run the Go TUI — ${run.error.message}`);
    return null;
  }
  return run.status ?? 0;
}
