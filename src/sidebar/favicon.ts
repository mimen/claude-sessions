/**
 * Finding and safely loading a project's own icon.
 *
 * The row's leading slot borrows the identity a project already publishes for itself, which is
 * far more recognizable than any glyph invented here. Only well-known raster favicon locations
 * inside the session's own directory are considered. SVG is deliberately excluded because a
 * top-level navigation would treat it as an active same-origin document rather than a passive
 * image.
 */
import { constants, lstatSync, realpathSync, type BigIntStats, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
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

const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_CACHED_FAVICONS = 64;

interface CachedFavicon {
  readonly body: ArrayBuffer;
  readonly stats: BigIntStats;
  readonly type: string;
}

const faviconCache = new Map<string, CachedFavicon>();

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

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function regularFileStatsAsync(path: string): Promise<BigIntStats | null> {
  try {
    const stats = await lstat(path, { bigint: true });
    return !stats.isSymbolicLink() && stats.isFile() && stats.nlink === 1n ? stats : null;
  } catch {
    return null;
  }
}

async function realPathIsContainedAsync(directory: string, path: string): Promise<boolean> {
  try {
    return isContainedPath(await realpath(directory), await realpath(path));
  } catch {
    return false;
  }
}

function cachedFavicon(path: string, stats: BigIntStats, type: string): FaviconAsset | null {
  const cached = faviconCache.get(path);
  if (!cached || cached.type !== type || !sameFileVersion(cached.stats, stats)) return null;
  faviconCache.delete(path);
  faviconCache.set(path, cached);
  return { body: cached.body.slice(0), type };
}

function cacheFavicon(path: string, stats: BigIntStats, type: string, body: ArrayBuffer): void {
  faviconCache.delete(path);
  faviconCache.set(path, { body: body.slice(0), stats, type });
  while (faviconCache.size > MAX_CACHED_FAVICONS) {
    const oldest = faviconCache.keys().next().value;
    if (typeof oldest !== "string") break;
    faviconCache.delete(oldest);
  }
}

async function readExact(handle: FileHandle, size: number): Promise<ArrayBuffer | null> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
    if (result.bytesRead === 0) return null;
    offset += result.bytesRead;
  }
  return bytes.buffer;
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
export async function loadFavicon(directory: string, path: string): Promise<FaviconAsset | null> {
  if (!isAbsolute(directory) || !isAbsolute(path) || !isCandidatePath(directory, path)) {
    return null;
  }
  const type = faviconContentType(path);
  const beforeOpen = await regularFileStatsAsync(path);
  if (!type || !beforeOpen || !await realPathIsContainedAsync(directory, path)) return null;

  let handle: FileHandle | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(beforeOpen, opened) || opened.size > BigInt(MAX_FAVICON_BYTES)) {
      return null;
    }

    // Confirm the pathname still names the opened regular file. The response is read from the
    // descriptor, so a later rename or symlink swap cannot change the bytes being served.
    const afterOpen = await regularFileStatsAsync(path);
    if (!afterOpen || !sameFile(opened, afterOpen)
      || !await realPathIsContainedAsync(directory, path)) {
      return null;
    }

    const cached = cachedFavicon(path, opened, type);
    if (cached) return cached;

    const body = await readExact(handle, Number(opened.size));
    if (!body || !sameFileVersion(opened, await handle.stat({ bigint: true }))) return null;
    cacheFavicon(path, opened, type, body);
    return { body, type };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
