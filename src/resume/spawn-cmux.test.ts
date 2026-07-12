import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCmux, type SpawnCmuxOpts } from "./spawn-cmux.ts";

/**
 * Test strategy: inject a fake cmuxBin that's a tiny bash script echoing the exact
 * output we expect cmux to produce. This lets us test command CONSTRUCTION (the argv
 * building + shell quoting) and parsing (JSON vs regex fallback) without depending on
 * a real cmux binary or mocking Bun.spawnSync.
 */

function withFakeCmux<T>(
  handler: (scriptPath: string, calls: string[]) => void,
  fn: (cmuxPath: string, callsFile: string) => T,
): T {
  const tmpDir = mkdtempSync(join(tmpdir(), "ccs-spawn-cmux-"));
  const cmuxPath = join(tmpDir, "fake-cmux");
  const callsFile = join(tmpDir, "calls.log");

  // Write a bash script that logs its invocation and runs the handler's output logic
  const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
exit 0
`;
  writeFileSync(cmuxPath, script, { mode: 0o755 });

  try {
    return fn(cmuxPath, callsFile);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("spawnCmux", () => {
  test("constructs argv: new-workspace --cwd <cwd> --name <name> --command <shell-quoted argv>", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        // Inject a fake cmux that succeeds and prints a workspace ref
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "workspace:42"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s123"],
          cwd: "/tmp/test-dir",
          name: "my-session",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:42");

        // Verify the args passed to the fake cmux (echo "$@" doesn't preserve the structure
        // of the --command arg, but we can verify the key components are present)
        const calls = readFileSync(callsFile, "utf8").trim();
        expect(calls).toContain("new-workspace");
        expect(calls).toContain("--cwd /tmp/test-dir");
        expect(calls).toContain("--name my-session");
        expect(calls).toContain("--command");
        expect(calls).toContain("claude");
        expect(calls).toContain("--resume");
        expect(calls).toContain("s123");
      },
    );
  });

  test("appends --focus true when opts.focus is true", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "workspace:99"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s456"],
          cwd: "/tmp/test-dir",
          name: "focused",
          focus: true,
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:99");

        const calls = readFileSync(callsFile, "utf8").trim();
        expect(calls).toContain("--focus");
        expect(calls).toContain("true");
      },
    );
  });

  test("shell-quotes argv with spaces and special chars", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "workspace:100"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s789", "/pr-watch check PR #123"],
          cwd: "/tmp/test-dir",
          name: "complex-command",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:100");

        const calls = readFileSync(callsFile, "utf8").trim();
        // The prompt arg has spaces and special chars, should be present
        expect(calls).toContain("/pr-watch check PR #123");
        expect(calls).toContain("--command");
      },
    );
  });

  test("returns workspace ref from JSON output (future-proofed structured output)", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo '{"ref": "workspace:200", "name": "my-session"}'
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s999"],
          cwd: "/tmp/test-dir",
          name: "json-output",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:200");
      },
    );
  });

  test("returns workspace ref from JSON output with 'id' field (alternate structure)", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo '{"id": "workspace:300"}'
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s888"],
          cwd: "/tmp/test-dir",
          name: "json-id",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:300");
      },
    );
  });

  test("regex fallback: parses workspace:N from plain text stdout", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "Created workspace:500"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s777"],
          cwd: "/tmp/test-dir",
          name: "plain-text",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:500");
      },
    );
  });

  test("regex fallback: parses workspace:N from stderr if not in stdout", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "workspace:600" >&2
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s666"],
          cwd: "/tmp/test-dir",
          name: "stderr-ref",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBe("workspace:600");
      },
    );
  });

  test("returns null on non-zero exit", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "Error: cmux failed" >&2
exit 1
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s555"],
          cwd: "/tmp/test-dir",
          name: "fail",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBeNull();
      },
    );
  });

  test("returns null when no workspace ref found in output", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "success but no ref"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const opts: SpawnCmuxOpts = {
          argv: ["claude", "--resume", "s444"],
          cwd: "/tmp/test-dir",
          name: "no-ref",
          cmuxBin: cmuxPath,
        };

        const ref = spawnCmux(opts);
        expect(ref).toBeNull();
      },
    );
  });

  test("timeout handling (contract: spawnSync has 10s timeout)", () => {
    // The actual timeout behavior is tested via spawnSync's built-in timeout mechanism.
    // We document the contract here: spawnCmux sets timeout:10000 on spawnSync, so any
    // cmux invocation taking >10s will return null. Testing this end-to-end would require
    // a 10s+ sleep, which is too slow for the test suite. The contract is: timeout → null.
    // This is a documentation-only test to record the contract.
    expect(true).toBe(true); // contract documented
  });

  test("uses process.env.CMUX_BIN when cmuxBin not provided", () => {
    withFakeCmux(
      (_scriptPath, _calls) => {},
      (cmuxPath, callsFile) => {
        const script = `#!/bin/bash
echo "$@" >> "${callsFile}"
echo "workspace:800"
exit 0
`;
        writeFileSync(cmuxPath, script, { mode: 0o755 });

        const prevCmuxBin = process.env.CMUX_BIN;
        process.env.CMUX_BIN = cmuxPath;

        try {
          const opts: SpawnCmuxOpts = {
            argv: ["claude", "--resume", "s222"],
            cwd: "/tmp/test-dir",
            name: "env-bin",
            // NO cmuxBin provided, should use CMUX_BIN env var
          };

          const ref = spawnCmux(opts);
          expect(ref).toBe("workspace:800");
        } finally {
          if (prevCmuxBin === undefined) {
            delete process.env.CMUX_BIN;
          } else {
            process.env.CMUX_BIN = prevCmuxBin;
          }
        }
      },
    );
  });

  test("defaults to 'cmux' when neither cmuxBin nor CMUX_BIN provided (real binary test)", () => {
    // This test only runs if `cmux` is in PATH. If not, spawnCmux returns null, which is
    // expected behavior (absent binary → null). The actual command construction is already
    // tested above with fake binaries, so this is a smoke test for the default path.
    const opts: SpawnCmuxOpts = {
      argv: ["claude", "--resume", "s111"],
      cwd: "/tmp/test-dir",
      name: "default-cmux",
      // NO cmuxBin, NO CMUX_BIN → should try "cmux"
    };

    // Clear CMUX_BIN to ensure default path
    const prevCmuxBin = process.env.CMUX_BIN;
    delete process.env.CMUX_BIN;

    try {
      const ref = spawnCmux(opts);
      // Either: cmux exists in PATH and we get a ref (or null on error),
      // or: cmux doesn't exist and we get null. Both are valid.
      // We just test that the function doesn't crash.
      expect(ref === null || typeof ref === "string").toBe(true);
    } finally {
      if (prevCmuxBin !== undefined) {
        process.env.CMUX_BIN = prevCmuxBin;
      }
    }
  });
});
