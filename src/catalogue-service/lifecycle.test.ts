import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { CatalogueHealthResult } from "./protocol.ts";
import { requestUnixHttp } from "./transport.ts";

const roots: string[] = [];
const sockets: string[] = [];
const bin = join(import.meta.dir, "..", "..", "bin", "ccs");

function setup(): { readonly root: string; readonly socketPath: string; readonly lockPath: string; readonly env: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "ccs-catalogue-lifecycle-"));
  roots.push(root);
  const store = join(root, "claude", "projects");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(root, "config.toml"), `[store]\npath = "${store}"\n`);
  const socketPath = join(tmpdir(), `${basename(root)}.sock`);
  sockets.push(socketPath);
  return {
    root,
    socketPath,
    lockPath: join(root, "run", "native-catalogue.lock"),
    env: { ...process.env, CCS_ROOT: root, CCS_CATALOGUE_SOCKET: socketPath },
  };
}

async function health(socketPath: string): Promise<CatalogueHealthResult | null> {
  try {
    const response = await requestUnixHttp(socketPath, "/v1/health", { timeoutMs: 200 });
    return response.status === 200 ? JSON.parse(response.body) as CatalogueHealthResult : null;
  } catch {
    return null;
  }
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for catalogue service state");
}

async function outputText(output: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
  return output instanceof ReadableStream ? await new Response(output).text() : "";
}

async function waitForHealth(socketPath: string, process: Bun.Subprocess): Promise<CatalogueHealthResult> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const live = await health(socketPath);
    if (live) return live;
    if (process.exitCode !== null) {
      const stdout = await outputText(process.stdout);
      const stderr = await outputText(process.stderr);
      throw new Error(`catalogue daemon exited ${process.exitCode}: ${stdout}${stderr}`);
    }
    await Bun.sleep(20);
  }
  throw new Error("timed out waiting for catalogue daemon health");
}

async function waitForExit(process: Bun.Subprocess, timeoutMs = 5_000): Promise<number> {
  return await Promise.race([
    process.exited,
    Bun.sleep(timeoutMs).then(() => {
      process.kill();
      throw new Error("catalogue daemon did not exit");
    }),
  ]);
}

afterEach(() => {
  for (const socket of sockets.splice(0)) rmSync(socket, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("daemon enforces one instance and cleans ownership files on explicit shutdown", async () => {
  const f = setup();
  const first = Bun.spawn([bin, "catalogue-service", "serve", "--idle-timeout-ms", "5000"], {
    env: f.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const live = await waitForHealth(f.socketPath, first);
    expect(live.service.pid).toBe(first.pid);
    expect(statSync(join(f.root, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(f.socketPath).mode & 0o777).toBe(0o600);

    const second = Bun.spawn([bin, "catalogue-service", "serve", "--idle-timeout-ms", "5000"], {
      env: f.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await waitForExit(second)).toBe(0);
    expect(await new Response(second.stdout).text()).toContain("already running");
    expect((await health(f.socketPath))?.service.instanceId).toBe(live.service.instanceId);

    const stopping = await requestUnixHttp(f.socketPath, "/_control/shutdown", { method: "POST" });
    expect(stopping.status).toBe(200);
    expect(await waitForExit(first)).toBe(0);
    await waitFor(async () => !existsSync(f.socketPath) && !existsSync(f.lockPath) ? true : null);
  } finally {
    if (await health(f.socketPath)) first.kill();
  }
}, 15_000);

test("a stale lock owned by a non-daemon PID is reclaimed", async () => {
  const f = setup();
  mkdirSync(f.lockPath, { recursive: true });
  writeFileSync(
    join(f.lockPath, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      instanceId: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    })}\n`,
  );
  const daemon = Bun.spawn([bin, "catalogue-service", "serve", "--idle-timeout-ms", "5000"], {
    env: f.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const live = await waitForHealth(f.socketPath, daemon);
  expect(live.service.pid).toBe(daemon.pid);
  expect(readFileSync(join(f.lockPath, "owner.json"), "utf8")).toContain(String(daemon.pid));
  await requestUnixHttp(f.socketPath, "/_control/shutdown", { method: "POST" });
  expect(await waitForExit(daemon)).toBe(0);
}, 15_000);

test("refresh command starts the authority on demand", async () => {
  const f = setup();
  const refresh = Bun.spawn([bin, "catalogue-service", "refresh", "--json"], {
    env: { ...f.env, CCS_CATALOGUE_IDLE_MS: "5000" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await waitForExit(refresh)).toBe(0);
  const stdout = await outputText(refresh.stdout);
  const result = JSON.parse(stdout) as { protocolVersion: number; sourceStatus: { generation: number } };
  expect(result.protocolVersion).toBe(1);
  expect(result.sourceStatus.generation).toBe(1);
  expect((await waitFor(() => health(f.socketPath))).service.pid).toBeGreaterThan(0);

  const stopping = await requestUnixHttp(f.socketPath, "/_control/shutdown", { method: "POST" });
  expect(stopping.status).toBe(200);
  await waitFor(async () => !existsSync(f.socketPath) && !existsSync(f.lockPath) ? true : null);
}, 15_000);

test("daemon idles out after the configured quiet period", async () => {
  const f = setup();
  const process = Bun.spawn([bin, "catalogue-service", "serve", "--idle-timeout-ms", "250"], {
    env: f.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(f.socketPath, process);
  expect(await waitForExit(process, 5_000)).toBe(0);
  await waitFor(async () => !existsSync(f.socketPath) && !existsSync(f.lockPath) ? true : null);
}, 10_000);
