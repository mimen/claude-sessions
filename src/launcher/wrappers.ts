import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { err, ok, type Result } from "../result.ts";
import type { Launcher } from "../resume/launchers.ts";
import { launcherEnvSpecFilename } from "./environment.ts";

export const BUNDLED_WRAPPER_BINARIES = ["claude-gpt", "claude-native", "claudex"] as const;
export const WRAPPER_MANIFEST_FILE = ".launcher-wrappers";

const bundledWrapperBinaries = new Set<string>(BUNDLED_WRAPPER_BINARIES);

export function isBundledWrapperBinary(value: string): boolean {
  return bundledWrapperBinaries.has(value);
}
const selectorPattern = /^export CCS_FORCE_HARNESS=[A-Za-z0-9._-]+$/gm;

export interface BundledWrapper {
  readonly binary: string;
  readonly launcher: string;
  readonly contents: string;
}

function managedBinaryName(binary: string, managedBinDirectory: string): string | null {
  if (!binary.includes("/")) return binary;
  const absolute = resolve(binary);
  return dirname(absolute) === resolve(managedBinDirectory) ? basename(absolute) : null;
}

function renderWrapper(contents: string, launcher: Launcher): Result<string> {
  const validName = launcherEnvSpecFilename(launcher.name);
  if (!validName.ok) return validName;
  const matches = contents.match(selectorPattern) ?? [];
  if (matches.length !== 1) {
    return err(new Error(
      `bundled wrapper "${launcher.binary}" must contain exactly one CCS_FORCE_HARNESS export`,
    ));
  }
  return ok(contents.replace(selectorPattern, `export CCS_FORCE_HARNESS=${launcher.name}`));
}

/** Resolve the bundled wrappers this fleet needs, without touching the live runtime. */
export function expectedBundledWrappers(
  sourceDirectory: string,
  managedBinDirectory: string,
  launchers: readonly Launcher[],
): Result<readonly BundledWrapper[]> {
  if (!existsSync(sourceDirectory)) {
    return err(new Error(`bundled launcher wrapper directory is missing: ${sourceDirectory}`));
  }

  const wrappers: BundledWrapper[] = [];
  const claimed = new Map<string, string>();
  for (const launcher of launchers) {
    const binary = managedBinaryName(launcher.binary, managedBinDirectory);
    if (binary === null || !isBundledWrapperBinary(binary)) continue;

    const prior = claimed.get(binary);
    if (prior !== undefined) {
      return err(new Error(
        `bundled wrapper binary "${binary}" is claimed by both "${prior}" and "${launcher.name}"`,
      ));
    }

    const source = join(sourceDirectory, binary);
    if (!existsSync(source)) {
      return err(new Error(`configured bundled launcher wrapper is missing: ${source}`));
    }
    let contents: string;
    try {
      contents = readFileSync(source, "utf8");
    } catch (error) {
      return err(new Error(
        `cannot read bundled launcher wrapper ${source}: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    const rendered = renderWrapper(contents, launcher);
    if (!rendered.ok) return rendered;
    claimed.set(binary, launcher.name);
    wrappers.push({ binary, launcher: launcher.name, contents: rendered.value });
  }

  wrappers.sort((left, right) => left.binary.localeCompare(right.binary));
  return ok(wrappers);
}

export function wrapperManifestContents(wrappers: readonly BundledWrapper[]): string {
  return wrappers.length > 0 ? `${wrappers.map((wrapper) => wrapper.binary).join("\n")}\n` : "";
}
