/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import { CategoryAccessibleText, CategoryMark } from "./category-mark.tsx";
import { CategorySummary } from "./summary-card.tsx";

function category(overrides: Partial<SidebarCategoryProjection> = {}): SidebarCategoryProjection {
  return {
    schema: 1,
    effectiveSlug: "events",
    storedSlug: "events",
    compactLabel: "Events",
    fullLabel: "Events, Booking & Live Production",
    hex: "#692EC2",
    order: 10,
    source: "manual",
    manualLock: true,
    finding: "stored",
    registryVersion: "1.0.0",
    ...overrides,
  };
}

describe("category row mark", () => {
  test("renders the authoritative registry color and accessible full label", () => {
    const projection = category();
    const mark = renderToStaticMarkup(<CategoryMark category={projection} />);
    const text = renderToStaticMarkup(<CategoryAccessibleText category={projection} />);
    expect(mark).toContain("background-color:#692EC2");
    expect(text).toContain("Category: Events, Booking &amp; Live Production.");
  });

  test("renders uncategorized as an outlined state with text", () => {
    const projection = category({
      effectiveSlug: null,
      storedSlug: null,
      compactLabel: null,
      fullLabel: null,
      hex: null,
      order: null,
      source: null,
      manualLock: false,
      finding: "uncategorized",
    });
    const mark = renderToStaticMarkup(<CategoryMark category={projection} />);
    const text = renderToStaticMarkup(<CategoryAccessibleText category={projection} />);
    expect(mark).toContain("border-muted-foreground/70");
    expect(mark).not.toContain("background-color");
    expect(text).toContain("Category: Uncategorized.");
  });

  test("renders nothing when the projection is unavailable", () => {
    expect(renderToStaticMarkup(<CategoryMark category={null} />)).toBe("");
    expect(renderToStaticMarkup(<CategoryAccessibleText category={null} />)).toBe("");
  });
});

describe("hover category summary", () => {
  test("uses the full label rather than the compact label", () => {
    const markup = renderToStaticMarkup(<CategorySummary category={category()} error={null} />);
    expect(markup).toContain("Events, Booking &amp; Live Production");
    expect(markup).not.toContain(">Events<");
    expect(markup).toContain("background-color:#692EC2");
  });

  test("names uncategorized honestly", () => {
    const projection = category({ effectiveSlug: null, fullLabel: null, hex: null, order: null });
    expect(renderToStaticMarkup(<CategorySummary category={projection} error={null} />))
      .toContain("Uncategorized");
  });

  test("shows the projection diagnostic when category data is unavailable", () => {
    const markup = renderToStaticMarkup(
      <CategorySummary category={null} error="category registry unreadable" />,
    );
    expect(markup).toContain("Category unavailable: category registry unreadable");
  });
});
