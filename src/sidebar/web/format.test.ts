/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import {
  emptyStateMessage,
  shouldApplySnapshotResponse,
  shouldReloadSnapshot,
} from "./format.ts";

describe("snapshot load coordination", () => {
  test("applies only the newest response for the selected scope", () => {
    expect(shouldApplySnapshotResponse("completed", "completed", 3, 2)).toBe(true);
    expect(shouldApplySnapshotResponse("completed", "completed", 2, 2)).toBe(false);
    expect(shouldApplySnapshotResponse("active", "completed", 4, 2)).toBe(false);
  });

  test("reloads for a changed scope without duplicating a request for the current scope", () => {
    expect(shouldReloadSnapshot("active", "completed", false)).toBe(true);
    expect(shouldReloadSnapshot("active", "active", false)).toBe(false);
    expect(shouldReloadSnapshot("active", "active", true)).toBe(true);
  });
});

describe("emptyStateMessage", () => {
  test("does not claim the queue is empty when liveness is unreadable", () => {
    expect(emptyStateMessage("", false)).toBeNull();
    expect(emptyStateMessage("sidebar", false)).toBeNull();
  });

  test("distinguishes an empty readable queue from an empty filter result", () => {
    expect(emptyStateMessage("", true)).toBe("Nothing running.");
    expect(emptyStateMessage("sidebar", true)).toBe("No sessions match.");
  });
});
