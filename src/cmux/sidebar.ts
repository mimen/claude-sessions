import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { err, ok, type Result } from "../result.ts";

export const CCS_SIDEBAR_NAME = "ccs";
export const CCS_SIDEBAR_SOURCE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "integrations",
  "cmux",
  "sidebars",
  "ccs.swift",
);

export type CcsSidebarInstallState = "installed" | "unchanged" | "overwritten";
export type CcsSidebarInspectionState = "missing" | "current" | "different";
export type CcsSidebarInstallErrorCode =
  | "source-unreadable"
  | "target-unreadable"
  | "unsupported-target"
  | "conflict"
  | "backup-failed"
  | "write-failed";

export class CcsSidebarInstallError extends Error {
  override readonly name = "CcsSidebarInstallError";

  constructor(
    readonly code: CcsSidebarInstallErrorCode,
    message: string,
    readonly targetPath: string,
    readonly backupPath: string | null = null,
  ) {
    super(message);
  }
}

export interface CcsSidebarInstallOptions {
  sourcePath?: string;
  targetPath?: string;
  backupPath?: string;
  force?: boolean;
}

export interface CcsSidebarInstallResult {
  state: CcsSidebarInstallState;
  sourcePath: string;
  targetPath: string;
  backupPath: string | null;
}

export interface CcsSidebarInspection {
  state: CcsSidebarInspectionState;
  sourcePath: string;
  targetPath: string;
}

export function ccsSidebarTargetPath(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".config", "cmux", "sidebars", `${CCS_SIDEBAR_NAME}.swift`);
}

function backupPathFor(targetPath: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${targetPath}.backup-${timestamp}`;
}

function readSource(sourcePath: string, targetPath: string): Result<string, CcsSidebarInstallError> {
  try {
    return ok(readFileSync(sourcePath, "utf8"));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new CcsSidebarInstallError(
      "source-unreadable",
      `Cannot read versioned sidebar source at ${sourcePath}: ${detail}`,
      targetPath,
    ));
  }
}

type TargetEntryState = "missing" | "regular-file";

function inspectTargetEntry(
  targetPath: string,
): Result<TargetEntryState, CcsSidebarInstallError> {
  try {
    const stats = lstatSync(targetPath);
    if (!stats.isFile()) {
      return err(new CcsSidebarInstallError(
        "unsupported-target",
        `Refusing to replace non-regular sidebar target at ${targetPath}. Remove or relocate it explicitly first.`,
        targetPath,
      ));
    }
    return ok("regular-file");
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") return ok("missing");
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new CcsSidebarInstallError(
      "target-unreadable",
      `Cannot inspect installed sidebar at ${targetPath}: ${detail}`,
      targetPath,
    ));
  }
}

function readTarget(targetPath: string): Result<string, CcsSidebarInstallError> {
  try {
    return ok(readFileSync(targetPath, "utf8"));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new CcsSidebarInstallError(
      "target-unreadable",
      `Cannot read installed sidebar at ${targetPath}: ${detail}`,
      targetPath,
    ));
  }
}

function writeAtomically(
  targetPath: string,
  content: string,
  replaceExisting: boolean,
): Result<void, CcsSidebarInstallError> {
  const targetDirectory = dirname(targetPath);
  const temporaryPath = join(
    targetDirectory,
    `.${basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (replaceExisting) {
      renameSync(temporaryPath, targetPath);
    } else {
      linkSync(temporaryPath, targetPath);
    }
    return ok(undefined);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new CcsSidebarInstallError(
      "write-failed",
      `Cannot install sidebar at ${targetPath}: ${detail}`,
      targetPath,
    ));
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
  }
}

export function inspectCcsSidebar(
  options: Pick<CcsSidebarInstallOptions, "sourcePath" | "targetPath"> = {},
): Result<CcsSidebarInspection, CcsSidebarInstallError> {
  const sourcePath = options.sourcePath ?? CCS_SIDEBAR_SOURCE_PATH;
  const targetPath = options.targetPath ?? ccsSidebarTargetPath();
  const source = readSource(sourcePath, targetPath);
  if (!source.ok) return source;

  const targetEntry = inspectTargetEntry(targetPath);
  if (!targetEntry.ok) return targetEntry;
  if (targetEntry.value === "missing") {
    return ok({ state: "missing", sourcePath, targetPath });
  }

  const target = readTarget(targetPath);
  if (!target.ok) return target;
  return ok({
    state: target.value === source.value ? "current" : "different",
    sourcePath,
    targetPath,
  });
}

export function installCcsSidebar(
  options: CcsSidebarInstallOptions = {},
): Result<CcsSidebarInstallResult, CcsSidebarInstallError> {
  const sourcePath = options.sourcePath ?? CCS_SIDEBAR_SOURCE_PATH;
  const targetPath = options.targetPath ?? ccsSidebarTargetPath();
  const source = readSource(sourcePath, targetPath);
  if (!source.ok) return source;

  const targetEntry = inspectTargetEntry(targetPath);
  if (!targetEntry.ok) return targetEntry;
  if (targetEntry.value === "missing") {
    const write = writeAtomically(targetPath, source.value, false);
    if (!write.ok) return write;
    return ok({ state: "installed", sourcePath, targetPath, backupPath: null });
  }

  const target = readTarget(targetPath);
  if (!target.ok) return target;
  if (target.value === source.value) {
    return ok({ state: "unchanged", sourcePath, targetPath, backupPath: null });
  }

  if (options.force !== true) {
    return err(new CcsSidebarInstallError(
      "conflict",
      `Refusing to overwrite a differing sidebar at ${targetPath}; inspect it or rerun with --force.`,
      targetPath,
    ));
  }

  const backupPath = options.backupPath ?? backupPathFor(targetPath);
  try {
    copyFileSync(targetPath, backupPath, constants.COPYFILE_EXCL);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return err(new CcsSidebarInstallError(
      "backup-failed",
      `Cannot preserve the existing sidebar at ${backupPath}: ${detail}`,
      targetPath,
      backupPath,
    ));
  }

  const write = writeAtomically(targetPath, source.value, true);
  if (!write.ok) {
    return err(new CcsSidebarInstallError(
      write.error.code,
      `${write.error.message} The previous file remains at ${backupPath}.`,
      targetPath,
      backupPath,
    ));
  }

  return ok({ state: "overwritten", sourcePath, targetPath, backupPath });
}
