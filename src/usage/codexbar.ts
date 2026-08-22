/**
 * Shared plumbing for adapters that shell out to CodexBar (`codexbar usage --provider X
 * --format json --pretty`). One failure mode contract: a missing binary, a nonzero exit, or
 * an unparseable payload degrades to AdapterHealth — it never throws into the snapshot path.
 */

import { err, ok, type Result } from "../result.ts";
import type { AdapterHealth } from "./types.ts";

export interface RawCodexBarEntry {
  provider?: string;
  source?: string;
  version?: string;
  error?: { code?: number; kind?: string; message?: string };
  usage?: unknown;
}

/** Run `codexbar` for one provider and parse its JSON array output. */
export function runCodexBar(
  provider: string,
  extraArgs: readonly string[] = [],
): Result<{ entries: RawCodexBarEntry[]; version: string | null }, AdapterHealth> {
  const bin = Bun.which("codexbar");
  if (!bin) {
    return err({
      provider: "codex",
      status: "unavailable",
      detail: "codexbar not found on PATH",
    });
  }
  const proc = Bun.spawnSync(
    [bin, "usage", "--provider", provider, "--format", "json", ...extraArgs],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    // CodexBar exits nonzero for provider-auth failures but still prints structured error
    // JSON on stdout. Prefer that message over the opaque "exited N" so doctor says WHY.
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(proc.stdout));
    } catch {
      const stderr = new TextDecoder().decode(proc.stderr).trim();
      return err({
        provider: "codex",
        status: "unavailable",
        detail: `codexbar exited ${proc.exitCode}${stderr ? `: ${stderr}` : ""}`,
      });
    }
    if (Array.isArray(parsed)) {
      return ok({ entries: parsed as RawCodexBarEntry[], version: null });
    }
    return err({
      provider: "codex",
      status: "unavailable",
      detail: `codexbar exited ${proc.exitCode}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(proc.stdout));
  } catch {
    return err({
      provider: "codex",
      status: "degraded",
      detail: "codexbar produced non-JSON output",
    });
  }
  if (!Array.isArray(parsed)) {
    return err({
      provider: "codex",
      status: "degraded",
      detail: "codexbar JSON was not the expected array shape",
    });
  }
  const entries = parsed as RawCodexBarEntry[];
  const version = entries.find((e) => typeof e.version === "string")?.version ?? null;
  return ok({ entries, version });
}

/** Build the AdapterHealth for a provider whose codexbar run returned per-entry errors. */
export function entryErrorHealth(provider: AdapterHealth["provider"], message: string): AdapterHealth {
  return { provider, status: "unavailable", detail: message };
}
