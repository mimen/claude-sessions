import { describe, expect, test } from "bun:test";
import { bunAsyncProcessAdapter } from "./async.ts";

const CHILD_THAT_IGNORES_SIGTERM = `
process.on("SIGTERM", () => {});
process.stdout.write("stdout-before-timeout\\n");
process.stderr.write("stderr-before-timeout\\n");
setInterval(() => {}, 1_000);
`;

describe("bunAsyncProcessAdapter", () => {
  test("escalates to SIGKILL when a timed-out child ignores SIGTERM", async () => {
    const startedAt = performance.now();

    const result = await bunAsyncProcessAdapter.run(
      process.execPath,
      ["--eval", CHILD_THAT_IGNORES_SIGTERM],
      { timeoutMs: 150, captureOutput: true },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({
      ok: false,
      stdout: "stdout-before-timeout\n",
      stderr: "stderr-before-timeout\n",
      timedOut: true,
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(150);
    expect(elapsedMs).toBeLessThan(1_000);
  }, 2_000);
});
