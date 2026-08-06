import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDirectoryFactsCache } from "./directory-facts.ts";

function repository(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ccs-facts-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("directory facts cache", () => {
  test("reports the favicon a directory publishes", async () => {
    const repo = repository();
    try {
      writeFileSync(join(repo.root, "favicon.png"), "icon");
      const cache = createDirectoryFactsCache();

      const facts = await cache.lookup([repo.root]);

      expect(facts.favicons.get(repo.root)).toBe(join(repo.root, "favicon.png"));
    } finally {
      repo.cleanup();
    }
  });

  test("reports no favicon for a directory without one", async () => {
    const repo = repository();
    try {
      const facts = await createDirectoryFactsCache().lookup([repo.root]);

      expect(facts.favicons.has(repo.root)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("serves a repeated lookup from the cache instead of re-reading disk", async () => {
    const repo = repository();
    try {
      const iconPath = join(repo.root, "favicon.png");
      writeFileSync(iconPath, "icon");
      let clock = 1_000;
      const cache = createDirectoryFactsCache(() => clock);

      await cache.lookup([repo.root]);
      rmSync(iconPath);
      clock += 5_000;
      const cached = await cache.lookup([repo.root]);

      expect(cached.favicons.get(repo.root)).toBe(iconPath);
    } finally {
      repo.cleanup();
    }
  });

  test("re-reads once the entry expires", async () => {
    const repo = repository();
    try {
      const iconPath = join(repo.root, "favicon.png");
      writeFileSync(iconPath, "icon");
      let clock = 1_000;
      const cache = createDirectoryFactsCache(() => clock);

      await cache.lookup([repo.root]);
      rmSync(iconPath);
      clock += 120_000;
      const refreshed = await cache.lookup([repo.root]);

      expect(refreshed.favicons.has(repo.root)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("forgets a directory that stops appearing, so its icon stops being servable", async () => {
    const first = repository();
    const second = repository();
    try {
      writeFileSync(join(first.root, "favicon.png"), "icon");
      const cache = createDirectoryFactsCache();

      const before = await cache.lookup([first.root]);
      expect(before.favicons.has(first.root)).toBe(true);

      const after = await cache.lookup([second.root]);
      expect(after.favicons.has(first.root)).toBe(false);
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
