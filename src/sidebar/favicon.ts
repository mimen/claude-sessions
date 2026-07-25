/**
 * Finding and safely loading a project's own icon.
 *
 * The row's leading slot borrows the identity a project already publishes for itself, which is
 * far more recognizable than any glyph invented here. Only well-known raster favicon locations
 * inside the session's own directory are considered. SVG is deliberately excluded because a
 * top-level navigation would treat it as an active same-origin document rather than a passive
 * image.
 */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Conventional passive favicon locations, most specific first. */
const CANDIDATES: readonly string[] = [
  "favicon.ico",
  "favicon.png",
  "public/favicon.ico",
  "public/favicon.png",
  "static/favicon.ico",
  "static/favicon.png",
  "assets/favicon.ico",
  "app/favicon.ico",
  "src/favicon.ico",
];

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ico: "image/x-icon",
  png: "image/png",
};

export interface FaviconAsset {
  readonly body: ArrayBuffer;
  readonly type: string;
}

/** The content type for a favicon path, or null when the extension is not a passive icon type. */
export function faviconContentType(path: string): string | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? null;
}

function isContainedPath(directory: string, path: string): boolean {
  const remainder = relative(directory, path);
  return remainder !== ""
    && remainder !== ".."
    && !remainder.startsWith(`..${sep}`)
    && !isAbsolute(remainder);
}

function isCandidatePath(directory: string, path: string): boolean {
  const resolvedPath = resolve(path);
  return CANDIDATES.some((candidate) => resolve(directory, candidate) === resolvedPath);
}

function regularFileStats(path: string): Stats | null {
  try {
    const stats = lstatSync(path);
    // Multiple links let an in-project filename expose an inode also named outside the project.
    return !stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1 ? stats : null;
  } catch {
    return null;
  }
}

function realPathIsContained(directory: string, path: string): boolean {
  try {
    return isContainedPath(realpathSync(directory), realpathSync(path));
  } catch {
    return false;
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The favicon a directory publishes, or null when it has no safe passive icon. */
export function findFavicon(directory: string): string | null {
  if (!isAbsolute(directory)) return null;
  for (const candidate of CANDIDATES) {
    const path = join(directory, candidate);
    if (regularFileStats(path) && realPathIsContained(directory, path)) return path;
  }
  return null;
}

/** Resolve favicons for several directories; directories without one are simply absent. */
export function findFavicons(directories: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const directory of new Set(directories)) {
    const favicon = findFavicon(directory);
    if (favicon) found.set(directory, favicon);
  }
  return found;
}

/**
 * Re-open a previously discovered favicon without following a replacement symlink.
 *
 * The descriptor is opened with `O_NOFOLLOW`, matched to the file inspected immediately before
 * the open, and read directly. A path replacement after the open cannot redirect that descriptor
 * to a different file.
 */
export function loadFavicon(directory: string, path: string): FaviconAsset | null {
  if (!isAbsolute(directory) || !isAbsolute(path) || !isCandidatePath(directory, path)) {
    return null;
  }
  const type = faviconContentType(path);
  const beforeOpen = regularFileStats(path);
  if (!type || !beforeOpen || !realPathIsContained(directory, path)) return null;

  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFile(beforeOpen, opened)) return null;

    // Confirm the pathname still names the opened regular file. The response is read from the
    // descriptor, so a later rename or symlink swap cannot change the bytes being served.
    const afterOpen = regularFileStats(path);
    if (!afterOpen || !sameFile(opened, afterOpen) || !realPathIsContained(directory, path)) {
      return null;
    }

    const fileBytes = readFileSync(descriptor);
    const body = new Uint8Array(fileBytes.byteLength);
    body.set(fileBytes);
    return { body: body.buffer, type };
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
