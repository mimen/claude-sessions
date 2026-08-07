import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _faviconCacheSnapshot,
  _resetFaviconCache,
  faviconContentType,
  findFavicon,
  loadFavicon,
} from "./favicon.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ccs-favicon-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  _resetFaviconCache();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("project favicons", () => {
  test("finds and loads a regular raster favicon", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "favicon.png");
    writeFileSync(path, "png bytes");

    expect(findFavicon(directory)).toBe(path);
    const favicon = await loadFavicon(directory, path);
    expect(favicon?.type).toBe("image/png");
    expect(favicon ? Buffer.from(favicon.body).toString() : null).toBe("png bytes");

    writeFileSync(path, "updated png bytes");
    const updated = await loadFavicon(directory, path);
    expect(updated ? Buffer.from(updated.body).toString() : null).toBe("updated png bytes");
  });

  test("serves cache hits, refreshes recency, and invalidates changed files", async () => {
    const firstDirectory = temporaryDirectory();
    const secondDirectory = temporaryDirectory();
    const firstPath = join(firstDirectory, "favicon.png");
    const secondPath = join(secondDirectory, "favicon.png");
    writeFileSync(firstPath, "first icon");
    writeFileSync(secondPath, "second icon");

    const first = await loadFavicon(firstDirectory, firstPath);
    expect(first ? Buffer.from(first.body).toString() : null).toBe("first icon");
    await loadFavicon(secondDirectory, secondPath);

    const hit = await loadFavicon(firstDirectory, firstPath);
    expect(hit ? Buffer.from(hit.body).toString() : null).toBe("first icon");
    expect(_faviconCacheSnapshot()).toEqual({
      hits: 1,
      paths: [secondPath, firstPath],
      totalBytes: Buffer.byteLength("first icon") + Buffer.byteLength("second icon"),
    });

    writeFileSync(firstPath, "changed first icon");
    const changed = await loadFavicon(firstDirectory, firstPath);
    expect(changed ? Buffer.from(changed.body).toString() : null).toBe("changed first icon");
    expect(_faviconCacheSnapshot()).toEqual({
      hits: 1,
      paths: [secondPath, firstPath],
      totalBytes: Buffer.byteLength("changed first icon") + Buffer.byteLength("second icon"),
    });
  });

  test("evicts the least recently used favicon when the byte budget is exceeded", async () => {
    const iconBytes = Buffer.alloc(256 * 1024, 7);
    const entries: Array<{ readonly directory: string; readonly path: string }> = [];
    for (let index = 0; index < 9; index += 1) {
      const directory = temporaryDirectory();
      const path = join(directory, "favicon.png");
      writeFileSync(path, iconBytes);
      entries.push({ directory, path });
      expect(await loadFavicon(directory, path)).not.toBeNull();
    }

    expect(_faviconCacheSnapshot()).toEqual({
      hits: 0,
      paths: entries.slice(1).map(({ path }) => path),
      totalBytes: 2 * 1024 * 1024,
    });

    expect(await loadFavicon(entries[1]!.directory, entries[1]!.path)).not.toBeNull();
    const extraDirectory = temporaryDirectory();
    const extraPath = join(extraDirectory, "favicon.png");
    writeFileSync(extraPath, iconBytes);
    expect(await loadFavicon(extraDirectory, extraPath)).not.toBeNull();

    expect(_faviconCacheSnapshot()).toEqual({
      hits: 1,
      paths: [...entries.slice(3).map(({ path }) => path), entries[1]!.path, extraPath],
      totalBytes: 2 * 1024 * 1024,
    });
  });

  test("refuses an oversized raster favicon", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "favicon.png");
    writeFileSync(path, Buffer.alloc(1024 * 1024));

    expect(findFavicon(directory)).toBe(path);
    expect(await loadFavicon(directory, path)).toBeNull();
  });

  test("refuses a symlinked favicon even when its target remains inside the project", async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "real.png"), "private bytes");
    symlinkSync("real.png", join(directory, "favicon.png"));

    expect(findFavicon(directory)).toBeNull();
    expect(await loadFavicon(directory, join(directory, "favicon.png"))).toBeNull();
  });

  test("refuses a regular favicon reached through a directory symlink outside the project", async () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(outside, "favicon.png"), "outside bytes");
    symlinkSync(outside, join(project, "public"));

    expect(findFavicon(project)).toBeNull();
    expect(await loadFavicon(project, join(project, "public", "favicon.png"))).toBeNull();
  });

  test("refuses a hard-linked favicon", async () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    const outside = join(root, "private-key");
    mkdirSync(project);
    writeFileSync(outside, "outside bytes");
    linkSync(outside, join(project, "favicon.png"));

    expect(findFavicon(project)).toBeNull();
    expect(await loadFavicon(project, join(project, "favicon.png"))).toBeNull();
  });

  test("does not recognize SVG as a servable favicon", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "favicon.svg");
    writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    expect(faviconContentType(path)).toBeNull();
    expect(findFavicon(directory)).toBeNull();
    expect(await loadFavicon(directory, path)).toBeNull();
  });
});
