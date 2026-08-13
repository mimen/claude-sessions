import { describe, expect, test } from "bun:test";
import {
  buildCategoryHealthReport,
  categoryHealthExitCode,
  checkDeployments,
  checkLocationMarkers,
  checkLocationSlugs,
  finding,
  renderCategoryHealthReport,
} from "./category-health.ts";
import type { LocationMarker } from "./category-health.ts";

const location = (over: Partial<LocationMarker> = {}): LocationMarker => ({
  key: "events",
  status: "active",
  hasCategory: true,
  category: "events",
  ...over,
});

describe("location markers", () => {
  test("a fully marked registry reports nothing", () => {
    expect(checkLocationMarkers([location(), location({ key: "music", category: "music" })])).toEqual([]);
  });

  test("an unmarked active location is drift, and the finding names it", () => {
    const found = checkLocationMarkers([location({ key: "finance", hasCategory: false, category: null })]);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("drift");
    expect(found[0]!.detail).toContain("finance");
    expect(found[0]!.remedy).toContain("category_neutral");
  });

  test("a retired location is exempt: it routes nothing, so it cannot misclassify", () => {
    expect(
      checkLocationMarkers([location({ key: "auf", status: "retired", hasCategory: false, category: null })]),
    ).toEqual([]);
  });

  test("an explicit neutral marker counts as marked", () => {
    expect(checkLocationMarkers([location({ key: "vault", hasCategory: true, category: null })])).toEqual([]);
  });
});

describe("location slugs", () => {
  const slugs = new Set(["events", "music"]);

  test("a known slug passes", () => {
    expect(checkLocationSlugs([location()], slugs)).toEqual([]);
  });

  test("an unknown slug is drift", () => {
    const found = checkLocationSlugs([location({ category: "retired-thing" })], slugs);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain("retired-thing");
  });

  test("a neutral location has no slug to validate", () => {
    expect(checkLocationSlugs([location({ category: null })], slugs)).toEqual([]);
  });
});

describe("deployments", () => {
  test("a service level with origin is clean", () => {
    expect(checkDeployments([{ name: "mindmap", host: "mini", behind: 0, error: null }])).toEqual([]);
  });

  test("a service behind origin is drift and says how far", () => {
    const found = checkDeployments([{ name: "mindmap", host: "mini", behind: 5, error: null }]);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("drift");
    expect(found[0]!.detail).toContain("5 commit");
  });

  test("an unreachable host warns rather than claiming drift", () => {
    const found = checkDeployments([{ name: "mindmap", host: "mini", behind: null, error: "unreachable" }]);
    expect(found[0]!.severity).toBe("warn");
  });
});

describe("report and exit code", () => {
  test("clean is exit 0", () => {
    expect(categoryHealthExitCode(buildCategoryHealthReport([], []))).toBe(0);
  });

  test("drift is exit 1", () => {
    const report = buildCategoryHealthReport([finding("x", "vault", "drift", "bad")], []);
    expect(categoryHealthExitCode(report)).toBe(1);
  });

  test("an unreachable area is exit 2, because unchecked is not clean", () => {
    expect(categoryHealthExitCode(buildCategoryHealthReport([], ["calendar"]))).toBe(2);
  });

  test("unreachable outranks drift: a partial answer must not read as a verdict", () => {
    const report = buildCategoryHealthReport([finding("x", "vault", "drift", "bad")], ["calendar"]);
    expect(categoryHealthExitCode(report)).toBe(2);
  });

  test("a warning alone does not fail", () => {
    expect(categoryHealthExitCode(buildCategoryHealthReport([finding("x", "vault", "warn", "hm")], []))).toBe(0);
  });
});

describe("rendering", () => {
  test("every area is named even when clean, so silence is not ambiguous", () => {
    const text = renderCategoryHealthReport(buildCategoryHealthReport([], []));
    for (const area of ["contract", "locations", "vault", "todoist", "calendar", "deployment"]) {
      expect(text).toContain(area);
    }
    expect(text).toContain("ok");
  });

  test("a repairable finding is marked as such", () => {
    const report = buildCategoryHealthReport(
      [finding("c", "calendar", "drift", "hex drift", { repairable: true })],
      [],
    );
    expect(renderCategoryHealthReport(report)).toContain("[repairable]");
  });

  test("a remedy is printed under its finding", () => {
    const report = buildCategoryHealthReport(
      [finding("c", "vault", "drift", "bad", { remedy: "run the thing" })],
      [],
    );
    expect(renderCategoryHealthReport(report)).toContain("fix: run the thing");
  });
});
