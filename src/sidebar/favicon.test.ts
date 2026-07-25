import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faviconContentType, findFavicon, loadFavicon } from "./favicon.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ccs-favicon-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

describe("project favicons", () => {
  test("finds and loads a regular raster favicon", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "favicon.png");
    writeFileSync(path, "png bytes");

    expect(findFavicon(directory)).toBe(path);
    const favicon = loadFavicon(directory, path);
    expect(favicon?.type).toBe("image/png");
    expect(favicon ? Buffer.from(favicon.body).toString() : null).toBe("png bytes");
  });

  test("refuses a symlinked favicon even when its target remains inside the project", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "real.png"), "private bytes");
    symlinkSync("real.png", join(directory, "favicon.png"));

    expect(findFavicon(directory)).toBeNull();
    expect(loadFavicon(directory, join(directory, "favicon.png"))).toBeNull();
  });

  test("refuses a regular favicon reached through a directory symlink outside the project", () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    const outside = join(root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    writeFileSync(join(outside, "favicon.png"), "outside bytes");
    symlinkSync(outside, join(project, "public"));

    expect(findFavicon(project)).toBeNull();
    expect(loadFavicon(project, join(project, "public", "favicon.png"))).toBeNull();
  });

  test("refuses a hard-linked favicon", () => {
    const root = temporaryDirectory();
    const project = join(root, "project");
    const outside = join(root, "private-key");
    mkdirSync(project);
    writeFileSync(outside, "outside bytes");
    linkSync(outside, join(project, "favicon.png"));

    expect(findFavicon(project)).toBeNull();
    expect(loadFavicon(project, join(project, "favicon.png"))).toBeNull();
  });

  test("does not recognize SVG as a servable favicon", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "favicon.svg");
    writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    expect(faviconContentType(path)).toBeNull();
    expect(findFavicon(directory)).toBeNull();
    expect(loadFavicon(directory, path)).toBeNull();
  });
});
