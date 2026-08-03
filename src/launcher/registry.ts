/**
 * The SHARED launcher registry — the versioned, backed-up home of the launcher fleet.
 *
 * WHY THIS EXISTS. `~/.ccs/config.toml` is machine-local runtime state (ADR-0049): not a git
 * repo, backed up nowhere. Once `[[launcher]].env` became the single source of the harness
 * environment, that one unversioned file held the gateway URL, the token reference, and the four
 * model slots — and losing it lost the configuration with no record of what it had been.
 *
 * THE DESIGN, and why it is the smallest one that fixes that. This is deliberately the SAME shape
 * the launch-location and remote-host registries already use: a curated TOML file in the git-backed
 * vault (`ClaudeConfig/session-routing/`), reached through a `[routing]` path key, normally by a
 * symlink at `~/.ccs/launchers.toml`. No new concept, no generator, no checked-in copy to keep in
 * sync — the machine file IS the vault file. Three properties follow directly:
 *
 *   - The single point of loss is gone: the fleet is committed and pushed with the vault.
 *   - The SECRET still never lands in git. Values keep the `@file:<path>` shape, so what is
 *     committed is the NAME of the file holding the token, never the token.
 *   - Per-machine differences remain possible, because `[[launcher]]` entries in config.toml
 *     still override the shared fleet by name (and may add host-only launchers). A binary that
 *     is not installed on this host must not be offered as a route, which is exactly the
 *     per-host fact config.toml is for.
 *
 * A machine with no shared registry behaves precisely as before: config.toml is the whole fleet.
 */
import { readFileSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { err, ok, type Result } from "../result.ts";

/** The dialect is intentionally small and mirrors the `[[launcher]]` block in config.toml. */
const LauncherRegistrySchema = z.object({
  version: z.number().int().positive(),
  launcher: z
    .array(
      z.object({
        name: z.string().min(1),
        binary: z.string().min(1),
        serves: z.array(z.string().min(1)).default(["*"]),
        env: z.record(z.string(), z.string()).default({}),
        clears: z.array(z.string().min(1)).default([]),
      }),
    )
    .default([]),
});

export type LauncherRegistry = z.infer<typeof LauncherRegistrySchema>;
export type LauncherRegistryEntry = LauncherRegistry["launcher"][number];

/** The schema version this build writes and understands. */
export const LAUNCHER_REGISTRY_VERSION = 1;

/**
 * Load the shared registry. A MISSING file is not an error — it means this host has no shared
 * fleet and config.toml is the whole story, which is the zero-config and pre-migration state.
 * Any other read/parse/validate failure is surfaced LOUDLY: silently falling back to a partial
 * fleet would resume a gateway session on the wrong subscription.
 */
export function loadLauncherRegistry(path: string): Result<LauncherRegistry | null> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ok(null);
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`failed to read launcher registry at ${path}: ${detail}`));
  }

  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new Error(`invalid TOML in launcher registry at ${path}: ${detail}`));
  }

  const parsed = LauncherRegistrySchema.safeParse(raw);
  if (!parsed.success) {
    return err(new Error(`invalid launcher registry at ${path}:\n${z.prettifyError(parsed.error)}`));
  }
  if (parsed.data.version > LAUNCHER_REGISTRY_VERSION) {
    return err(new Error(
      `launcher registry at ${path} declares version ${parsed.data.version}, ` +
        `but this ccs understands ${LAUNCHER_REGISTRY_VERSION} — upgrade ccs rather than downgrading the file`,
    ));
  }

  const seen = new Set<string>();
  for (const entry of parsed.data.launcher) {
    if (seen.has(entry.name)) {
      return err(new Error(`duplicate launcher name "${entry.name}" in ${path}`));
    }
    seen.add(entry.name);
  }

  return ok(parsed.data);
}

/**
 * Fold the shared fleet and this machine's `[[launcher]]` entries into one list.
 *
 * Shared entries come first, in registry order, so the daily driver's position — the tie-break for
 * a session with no model history — is a VERSIONED decision rather than a per-machine accident. A
 * config.toml entry with the same name REPLACES the shared one in place (keeping its ordering);
 * a new name is appended. That is what keeps a per-host override possible without forking the
 * whole fleet, and it is deliberately last-writer-wins on the whole entry rather than a deep
 * merge: a half-overridden `env` would be far harder to reason about than a replacement.
 */
export function mergeLauncherFleet(
  shared: readonly LauncherRegistryEntry[],
  machine: readonly LauncherRegistryEntry[],
): LauncherRegistryEntry[] {
  const overrides = new Map(machine.map((entry) => [entry.name, entry]));
  const merged: LauncherRegistryEntry[] = shared.map(
    (entry) => overrides.get(entry.name) ?? entry,
  );
  const sharedNames = new Set(shared.map((entry) => entry.name));
  for (const entry of machine) {
    if (!sharedNames.has(entry.name)) merged.push(entry);
  }
  return merged;
}
