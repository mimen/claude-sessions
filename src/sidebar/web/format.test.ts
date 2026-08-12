/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { SidebarCategoryProjection } from "../category-projection.ts";
import {
  emptyStateMessage,
  GROUPING_LABELS,
  groupSessions,
  nextGroupingMode,
  parseGroupingMode,
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

describe("category grouping", () => {
  const projection = (
    slug: string | null,
    compactLabel: string | null,
    order: number | null,
    hex: string | null,
  ): SidebarCategoryProjection => ({
    schema: 1,
    effectiveSlug: slug,
    storedSlug: slug,
    compactLabel,
    fullLabel: compactLabel,
    hex,
    order,
    source: slug ? "manual" : null,
    manualLock: false,
    finding: slug ? "stored" : "uncategorized",
    registryVersion: "1.0.0",
  });
  const row = (id: string, category: SidebarCategoryProjection | null) => ({
    id,
    kind: "session" as const,
    section: "ready" as const,
    directory: "ccs",
    lastActivityAt: 0,
    pinned: false,
    density: "full" as const,
    category,
  });

  test("exposes and cycles the category mode", () => {
    expect(parseGroupingMode("category")).toBe("category");
    expect(GROUPING_LABELS.category).toBe("By category");
    expect(nextGroupingMode("project")).toBe("category");
    expect(nextGroupingMode("category")).toBe("recent");
  });

  test("uses projected registry order and keeps Uncategorized last", () => {
    const groups = groupSessions([
      row("uncategorized", projection(null, null, null, null)),
      row("later", projection("later", "Later", 9, "#990000")),
      row("unavailable", null),
      row("earlier", projection("earlier", "Earlier", 2, "#220000")),
    ], "category", 0);

    expect(groups.map((group) => group.label)).toEqual([
      "Earlier",
      "Later",
      "Category unavailable",
      "Uncategorized",
    ]);
    expect(groups.map((group) => group.color ?? null)).toEqual([
      "#220000",
      "#990000",
      null,
      null,
    ]);
    expect(groups.at(-1)?.outlineMark).toBe(true);
    expect(groups.at(-1)?.rows.map((member) => member.id)).toEqual(["uncategorized"]);
  });

  test("degrades to one intentional group when nearly everything is uncategorized", () => {
    const uncategorized = projection(null, null, null, null);
    const groups = groupSessions([
      row("one", uncategorized),
      row("two", uncategorized),
      row("three", uncategorized),
    ], "category", 0);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Uncategorized");
    expect(groups[0]?.rows).toHaveLength(3);
    expect(groups[0]?.outlineMark).toBe(true);
  });
});

describe("status grouping", () => {
  test("shows recent sessions newest first", () => {
    const recentRow = (id: string, lastActivityAt: number) => ({
      id,
      kind: "session" as const,
      section: "recent" as const,
      directory: "ccs",
      lastActivityAt,
      pinned: false,
      density: "line" as const,
    });

    const groups = groupSessions([
      recentRow("oldest", 100),
      recentRow("newest", 300),
      recentRow("middle", 200),
    ], "status", 0);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows.map((row) => row.id)).toEqual(["newest", "middle", "oldest"]);
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
