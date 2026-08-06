/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { browserStatusIcon, StatusIcon, validatedStatusColor } from "./status-icon.tsx";

describe("browserStatusIcon", () => {
  test("maps the supported SF Symbol names to browser glyphs", () => {
    expect(browserStatusIcon("bell.fill")).toBe("bell");
    expect(browserStatusIcon("bolt.fill")).toBe("bolt");
    expect(browserStatusIcon("hand.raised.fill")).toBe("hand-raised");
    expect(browserStatusIcon("pause.fill")).toBe("pause");
    expect(browserStatusIcon("checkmark.circle.fill")).toBe("checkmark-circle");
  });

  test("renders bell.fill as an inline bell using the supplied status color", () => {
    const markup = renderToStaticMarkup(StatusIcon({ color: "#4C8DFF", icon: "bell.fill" }));

    expect(markup).toContain("<svg");
    expect(markup).toContain('style="color:#4C8DFF"');
    expect(markup.match(/<path/g) ?? []).toHaveLength(2);
    expect(markup).not.toContain("rounded-full");
  });

  test("falls back to a neutral dot for missing or unmapped icons", () => {
    expect(browserStatusIcon("questionmark")).toBe("dot");
    expect(browserStatusIcon(null)).toBe("dot");
  });
});

describe("validatedStatusColor", () => {
  test("preserves valid CSS hex colors exactly", () => {
    expect(validatedStatusColor("#4C8DFF")).toBe("#4C8DFF");
    expect(validatedStatusColor("#abc")).toBe("#abc");
    expect(validatedStatusColor("#abcd")).toBe("#abcd");
    expect(validatedStatusColor("#11223344")).toBe("#11223344");
  });

  test("rejects missing and non-hex style values", () => {
    expect(validatedStatusColor(null)).toBeUndefined();
    expect(validatedStatusColor("red")).toBeUndefined();
    expect(validatedStatusColor("#12")).toBeUndefined();
    expect(validatedStatusColor("#12345g")).toBeUndefined();
    expect(validatedStatusColor("var(--status-color)")).toBeUndefined();
  });
});
