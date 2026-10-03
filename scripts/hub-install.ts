#!/usr/bin/env bun
/**
 * The hub half of installing ccs: write the read and ingest bearer files from 1Password, then
 * tell the hub which ccs build this Mac runs. `bun run setup` calls both; run this file alone
 * to refresh the tokens.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_SITE, readHubToken, tokenFile, tokenRef, type HubTokenKind } from "../src/usage/hub.ts";

const KINDS: HubTokenKind[] = ["read", "ingest"];

/** Idempotent: a file already holding the current value is only re-chmodded. */
export function installHubTokens(home = homedir(), read = (ref: string) => execFileSync("op", ["read", ref], {
  encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OP_LOAD_DESKTOP_APP_SETTINGS: "false" },
})): void {
  const values = KINDS.map((kind) => {
    const value = read(tokenRef(kind)).trim();
    if (!value) throw new Error(`empty ${tokenRef(kind)}`);
    return { path: tokenFile(kind, home), value: `${value}\n` };
  });
  for (const { path, value } of values) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let current: string | undefined;
    try { current = readFileSync(path, "utf8"); } catch {}
    if (current !== value) {
      writeFileSync(`${path}.tmp`, value, { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    }
    chmodSync(path, 0o600);
  }
}

/** The fleet's short name for this Mac, as the fleet-check job reports it. */
export function buildHost(home = homedir()): string | null {
  if (process.env.HUB_HOST) return process.env.HUB_HOST;
  try {
    return execFileSync("/usr/bin/plutil", ["-extract", "EnvironmentVariables.HUB_HOST", "raw", "-o", "-",
      `${home}/Library/LaunchAgents/com.milad.fleet-check.plist`],
    { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

/** POST /ingest/build. Never throws; false on any failure, including a hub that lacks the route. */
export async function reportBuild(sha: string, opts: { host?: string | null; token?: string | null; fetch?: typeof fetch } = {}): Promise<boolean> {
  const host = opts.host !== undefined ? opts.host : buildHost();
  const token = opts.token !== undefined ? opts.token : await readHubToken("ingest");
  if (!host || !token || !/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    const res = await (opts.fetch ?? fetch)(`${process.env.HUB_SITE || HUB_SITE}/ingest/build`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ host, component: "ccs", sha, reportedAt: Date.now() }),
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function checkoutSha(): string | null {
  try {
    return execFileSync("git", ["-C", dirname(dirname(fileURLToPath(import.meta.url))), "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Token files, then the build report. Returns false only when a token file is still missing. */
export async function hubInstall(): Promise<boolean> {
  try {
    installHubTokens();
    console.log(`✓ hub tokens at ${tokenFile("read")} and ${tokenFile("ingest")} (0600)`);
  } catch (e) {
    const missing = KINDS.filter((kind) => !existsSync(tokenFile(kind)));
    console.log(`${missing.length ? "✗" : "!"} hub tokens not refreshed from 1Password: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
    if (missing.length) return false;
  }
  const sha = checkoutSha();
  const reported = sha ? await reportBuild(sha) : false;
  console.log(`${reported ? "✓" : "!"} build ${sha?.slice(0, 7) ?? "unknown"} ${reported ? "reported to the hub" : "not reported to the hub"}`);
  return true;
}

if (import.meta.main) process.exitCode = (await hubInstall()) ? 0 : 1;
