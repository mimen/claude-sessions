import { expect, test } from "bun:test";

/**
 * Unit test for liveByCwd is integration-level (requires cmux binary), so we just document
 * the expected contract here. The actual implementation is tested via the system resume
 * integration tests.
 */

test("liveByCwd: contract documentation", () => {
  // liveByCwd(cmuxBin = "cmux"): Set<string>
  // - Reads `cmux tree --all --json`
  // - Parses windows[].workspaces[].current_directory
  // - Returns a Set of absolute cwd paths that have live cmux workspaces
  // - Returns empty Set when cmux isn't reachable (safe for idempotency)
  expect(true).toBe(true);
});
