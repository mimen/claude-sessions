import { test, expect } from "bun:test";
import { formatBytes } from "./store.ts";

test("formatBytes scales units", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(512)).toBe("512 B");
  expect(formatBytes(1024)).toBe("1 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(298 * 1024 * 1024)).toBe("298 MB");
});
