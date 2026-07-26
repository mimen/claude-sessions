import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { listByRecency } from "./index.ts";
import { openIndex } from "./schema.ts";

const UUID_A = "123e4567-e89b-42d3-a456-426614174000";
const UUID_B = "223e4567-e89b-42d3-a456-426614174001";
const CCS_BIN = join(import.meta.dir, "..", "..", "bin", "ccs");
const REPO_ROOT = join(import.meta.dir, "..", "..");

function transcript(sessionId: string, cwd: string, title: string, timestamp: string): string {
  return `${JSON.stringify({
    type: "user",
    uuid: `${sessionId}-user`,
    sessionId,
    cwd,
    timestamp,
    message: { role: "user", content: title },
  })}\n`;
}

function runCcs(root: string, socketPath: string, args: readonly string[]): void {
  const result = Bun.spawnSync({
    cmd: [CCS_BIN, ...args],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      CCS_ROOT: root,
      CCS_CATALOGUE_SOCKET: socketPath,
      CCS_CATALOGUE_IDLE_MS: "5000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `ccs ${args.join(" ")} failed (${result.exitCode}):\n${result.stdout.toString()}${result.stderr.toString()}`,
    );
  }
}

function browseSessionIds(indexPath: string): string[] {
  const db = openIndex(indexPath);
  try {
    return listByRecency(db).map((row) => row.sessionId).sort();
  } finally {
    db.close();
  }
}

async function stopCatalogueService(root: string, socketPath: string): Promise<void> {
  runCcs(root, socketPath, ["catalogue-service", "stop"]);
  const lockPath = join(root, "run", "native-catalogue.lock");
  const deadline = Date.now() + 5_000;
  while (existsSync(socketPath) || existsSync(lockPath)) {
    if (Date.now() >= deadline) throw new Error("catalogue service did not stop");
    await Bun.sleep(20);
  }
}

test("deleting the index and reindexing restores the browse set from the Store", async () => {
  const root = mkdtempSync(join(tmpdir(), "ccs-cache-invariant-"));
  const socketPath = join(tmpdir(), `${basename(root)}.sock`);
  const store = join(root, "claude", "projects", "project");
  const cwdA = join(root, "workspace-a");
  const cwdB = join(root, "workspace-b");
  const indexPath = join(root, "cache", "index.db");

  mkdirSync(store, { recursive: true });
  mkdirSync(cwdA, { recursive: true });
  mkdirSync(cwdB, { recursive: true });
  writeFileSync(join(root, "config.toml"), `[store]\npath = "${join(root, "claude", "projects")}"\n`);
  writeFileSync(
    join(store, `${UUID_A}.jsonl`),
    transcript(UUID_A, cwdA, "First cached session", "2026-07-20T10:00:00.000Z"),
  );
  writeFileSync(
    join(store, `${UUID_B}.jsonl`),
    transcript(UUID_B, cwdB, "Second cached session", "2026-07-21T10:00:00.000Z"),
  );

  try {
    runCcs(root, socketPath, ["reindex"]);
    expect(existsSync(indexPath)).toBe(true);
    const beforeDeletion = browseSessionIds(indexPath);
    expect(beforeDeletion).toEqual([UUID_A, UUID_B]);

    await stopCatalogueService(root, socketPath);
    rmSync(indexPath);
    expect(existsSync(indexPath)).toBe(false);

    runCcs(root, socketPath, ["reindex"]);
    expect(browseSessionIds(indexPath)).toEqual(beforeDeletion);
  } finally {
    try {
      await stopCatalogueService(root, socketPath);
    } finally {
      rmSync(socketPath, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20_000);
