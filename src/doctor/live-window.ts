/**
 * `ccs doctor models --live`: the window Claude Code REALLY accounts a model at, read from a run.
 *
 * The declaration doctor compares files against the registry's assumptions, so when Claude Code
 * changes what an id means (2.1.287 made a bare Claude 5 id 1M, which turned Grok's 200K donor
 * into a 980K overrun) every file still matches and the doctor still says OK. The only thing that
 * cannot be fooled is the `autocompact: ... effectiveWindow=N` line a headless run writes to its
 * debug file. This module owns the expectation and the comparison; the io file runs the CLI.
 */
import { familyOf, modelWindows, pickerRows, slots, type ModelRegistry } from "../models/registry.ts";

/**
 * Claude Code holds back the smaller of the model's max output and 20,000 tokens before it
 * measures the window, and every current model's max output is above that, so the reserve is a
 * constant. Measured 2026-10-09 on 2.1.296: 1,000,000 logs 980000, 100,000 logs 80000.
 */
export const OUTPUT_RESERVE = 20_000;

export interface LiveWindowExpectation {
  readonly model: string;
  /** The declared id to launch with, marker included. */
  readonly declaration: string;
  readonly expected: number;
}

export interface LiveWindowResult extends LiveWindowExpectation {
  /** Null when the run wrote no autocompact line, which is itself a finding. */
  readonly observed: number | null;
  /** The run's last stderr line when it failed before reaching the check. */
  readonly error?: string;
}

/**
 * Every picker model on the launcher and the effectiveWindow its run must log: the real window
 * where the launcher pins one, the envelope where the model is at or above it, and the family
 * window for a marker family, each minus the output reserve.
 *
 * `userCeilings` is the `modelSettings.<id>.autoCompactWindow` map from the user's own
 * settings.json. Claude Code applies the lowest ceiling it finds, and a user may pin a model
 * below its real window on purpose (Haiku 5.5 at 100,000 for its price tier), so a user ceiling
 * below the registry's window is the expectation, not a finding.
 */
export function liveWindowExpectations(
  registry: ModelRegistry,
  launcher: string,
  userCeilings: Readonly<Record<string, number>> = {},
): readonly LiveWindowExpectation[] {
  const envelope = slots(registry, launcher)?.max_context;
  const pinned = modelWindows(registry, launcher);
  const expectations: LiveWindowExpectation[] = [];
  for (const row of pickerRows(registry, launcher)) {
    const id = row.model.replace(/\[1m\]$/, "");
    const family = familyOf(registry, id);
    if (!family) continue;
    const registryWindow = family.accounting === "marker" ? family.window : pinned[id] ?? envelope;
    if (registryWindow === undefined) continue;
    const ceiling = userCeilings[id];
    const window = ceiling !== undefined ? Math.min(registryWindow, ceiling) : registryWindow;
    expectations.push({ model: id, declaration: row.model, expected: window - OUTPUT_RESERVE });
  }
  return expectations;
}

/** The per-model ceilings a Claude Code settings.json carries, keyed by canonical id. */
export function userWindowCeilings(settingsText: string): Readonly<Record<string, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsText);
  } catch {
    return {};
  }
  const modelSettings = (parsed as { modelSettings?: unknown })?.modelSettings;
  if (typeof modelSettings !== "object" || modelSettings === null) return {};
  const ceilings: Record<string, number> = {};
  for (const [id, entry] of Object.entries(modelSettings as Record<string, unknown>)) {
    const window = (entry as { autoCompactWindow?: unknown })?.autoCompactWindow;
    if (typeof window === "number" && Number.isFinite(window)) ceilings[id.replace(/\[1m\]$/, "")] = window;
  }
  return ceilings;
}

/** The last effectiveWindow a debug file reports, or null when the run never reached the check. */
export function parseEffectiveWindow(debugLog: string): number | null {
  let last: number | null = null;
  for (const match of debugLog.matchAll(/autocompact: tokens=\S+ level=\w+ effectiveWindow=(\d+)/g)) {
    last = Number(match[1]);
  }
  return last;
}

export function liveWindowFindings(results: readonly LiveWindowResult[]): readonly string[] {
  const findings: string[] = [];
  for (const result of results) {
    if (result.observed === null) {
      const why = result.error ? ` (${result.error})` : "";
      findings.push(`${result.model}: no effectiveWindow logged; expected ${result.expected}${why}`);
    } else if (result.observed !== result.expected) {
      const direction = result.observed > result.expected ? "overrun" : "undercount";
      findings.push(`${result.model}: accounted ${result.observed}, expected ${result.expected} (${direction})`);
    }
  }
  return findings;
}

export function renderLiveWindowReport(launcher: string, results: readonly LiveWindowResult[]): string {
  const lines = [`Live context windows on ${launcher}`];
  for (const result of results) {
    const mark = result.observed === result.expected ? "ok  " : "FAIL";
    lines.push(`  ${mark} ${result.model.padEnd(28)} accounted ${String(result.observed ?? "none").padStart(8)}  expected ${String(result.expected).padStart(8)}`);
  }
  const findings = liveWindowFindings(results);
  lines.push(findings.length === 0
    ? `OK - every model compacts at its real window.`
    : `${findings.length} model(s) accounted at the wrong window. Nothing was changed.`);
  return lines.join("\n");
}
