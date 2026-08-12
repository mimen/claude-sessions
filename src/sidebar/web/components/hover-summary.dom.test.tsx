/// <reference types="bun" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import type { SidebarSessionRow } from "../../projection.ts";
import { HoverSummary } from "./hover-summary.tsx";

type Root = ReturnType<typeof createRoot>;

const category: SidebarCategoryProjection = {
  schema: 1,
  effectiveSlug: "ai-systems",
  storedSlug: "ai-systems",
  compactLabel: "AI Systems",
  fullLabel: "AI Systems, Automation & Technical Infrastructure",
  hex: "#2A67E2",
  order: 20,
  source: "manual",
  manualLock: true,
  finding: "stored",
  registryVersion: "1.0.0",
};

const row: SidebarSessionRow = {
  kind: "session",
  id: "session-1",
  sessionId: "session-1",
  density: "line",
  pinned: false,
  focused: false,
  name: "Artist data, fee model, and collector safeguards",
  directory: "auf-booking-intel",
  directoryPath: "/tmp/auf-booking-intel",
  faviconUrl: null,
  worktree: null,
  status: null,
  statusAvailability: "not-live",
  lastActivityAt: 1_000,
  section: "recent",
  workspaceRef: null,
  workspaceId: null,
  shortcut: null,
  windowRef: null,
  windowId: null,
  unread: 0,
  lifecycle: "active",
  model: null,
  summary: {
    state: "A long summary whose height depends on the final width of the card.",
    history: null,
    next: "Compare the branch with master before integrating it.",
    remaining: null,
    recommendation: null,
    reason: null,
    junk: false,
    atMessages: 10,
    at: "2026-08-12T00:00:00Z",
    declined: null,
    driftLabel: null,
    messagesSince: 0,
  },
  suggestion: null,
  membership: null,
  category,
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  if (typeof document === "undefined") return;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterAll(() => {
  if (typeof document === "undefined") return;
  act(() => root.unmount());
  container.remove();
});

const mounted = typeof document === "undefined" ? describe.skip : describe;

mounted("hover summary, mounted", () => {
  test("positions a lower-half card using its final row-width height", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 350 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });

    let targetRect = new DOMRect(6, 679, 338, 46);
    const targetElement = document.createElement("button");
    targetElement.getBoundingClientRect = (): DOMRect => targetRect;
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement): number {
        if (!this.classList.contains("fixed")) return 0;
        return this.style.width === "338px" ? 170 : 415;
      },
    });

    try {
      act(() => {
        root.render(
          <HoverSummary
            categoryProjectionError={null}
            target={{ row, element: targetElement, rect: targetRect }}
          />,
        );
      });

      const card = container.querySelector<HTMLElement>(".fixed");
      expect(card).not.toBeNull();
      expect(card?.style.width).toBe("338px");
      expect(card?.style.top).toBe("503px");
      expect(card?.style.visibility).toBe("visible");

      targetRect = new DOMRect(6, 379, 338, 46);
      act(() => window.dispatchEvent(new Event("scroll")));
      expect(card?.style.top).toBe("431px");
    } finally {
      if (originalOffsetHeight) {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      } else {
        delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
      }
    }
  });
});
