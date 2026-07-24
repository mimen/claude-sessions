import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestUnixHttp } from "./transport.ts";

test("Unix transport can disable the short health timeout for long authority work", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-transport-"));
  const socketPath = join(root, "service.sock");
  const server = Bun.serve({
    unix: socketPath,
    async fetch(): Promise<Response> {
      await Bun.sleep(40);
      return Response.json({ ok: true });
    },
  });
  try {
    const startedAt = Date.now();
    const response = await requestUnixHttp(socketPath, "/", { timeoutMs: 0 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  } finally {
    await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
