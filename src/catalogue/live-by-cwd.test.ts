import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { liveByCwd } from "./live-by-cwd.ts";

/**
 * liveByCwd shells out to cmux, so we test it against a FAKE cmux binary (a tiny
 * shell script emitting a canned `list-workspaces --json`). This locks the JSON
 * shape — the go-live bug was liveByCwd reading `tree --json` (no current_directory)
 * instead of `list-workspaces --json`, so it always returned empty and resume spawned
 * duplicate panes on every run. A shape regression must fail here.
 */

function fakeCmux(payload: string): string {
  const path = `/tmp/fake-cmux-${payload.length}-${payload.replace(/\W/g, "").slice(0, 8)}.sh`;
  // Emit the payload only for `list-workspaces --json`; anything else -> empty.
  const script = `#!/bin/sh\ncase "$1 $2" in\n"list-workspaces --json") cat <<'JSON'\n${payload}\nJSON\n;; *) echo "" ;;\nesac\n`;
  Bun.write(path, script);
  execFileSync("chmod", ["+x", path]);
  return path;
}

test("liveByCwd: parses current_directory from list-workspaces --json", () => {
  const bin = fakeCmux(
    JSON.stringify({
      workspaces: [
        { ref: "workspace:1", current_directory: "/wt/a" },
        { ref: "workspace:2", current_directory: "/wt/b" },
        { ref: "workspace:3", current_directory: null }, // no cwd -> skipped
      ],
    }),
  );
  const live = liveByCwd(bin);
  expect(live.has("/wt/a")).toBe(true);
  expect(live.has("/wt/b")).toBe(true);
  expect(live.size).toBe(2);
});

test("liveByCwd: empty set when cmux unreachable (safe for idempotency)", () => {
  const live = liveByCwd("/definitely/not/a/real/cmux/binary");
  expect(live.size).toBe(0);
});
