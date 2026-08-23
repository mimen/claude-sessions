/// <reference types="bun" />
/**
 * The row, mounted and interacted with.
 *
 * Every other component test renders to a static string, and `renderToStaticMarkup` emits nothing
 * at all for portal children — so an open menu is invisible to that style and a broken one looks
 * identical to a working one. A Base UI crash reached a release through exactly that blind spot:
 * a menu label rendered outside its group threw on right-click, took the whole tree down, and the
 * suite stayed green.
 *
 * This file exists to cover what a string cannot: mount, interact, and assert on what the browser
 * would actually show.
 *
 * It runs under `bun run test:dom`, not the main suite, and skips itself when no DOM is present.
 * The DOM has to be installed by a preload, because `react-dom` binds to whatever globals exist
 * when it first loads and a server-rendering test that imports it earlier would leave this one
 * with a React that can never attach a listener. That preload cannot be global: happy-dom replaces
 * `fetch`, and the server tests make real requests against a real Bun server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import type { SidebarSessionRow } from "../../projection.ts";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { SessionRow } from "./session-row.tsx";

type Root = ReturnType<typeof createRoot>;

const category: SidebarCategoryProjection = {
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
};

function session(overrides: Partial<SidebarSessionRow> = {}): SidebarSessionRow {
  return {
    kind: "session",
    id: "session-1",
    sessionId: "session-1",
    density: "full",
    pinned: false,
    focused: false,
    name: "A session with a context menu",
    directory: "claude-sessions",
    directoryPath: "/tmp/claude-sessions",
    faviconUrl: null,
    worktree: null,
    status: { label: "Waiting", icon: "bell.fill", color: "#4C8DFF" },
    statusAvailability: "published",
    lastActivityAt: 1_000,
    section: "needs-you",
    workspaceRef: "workspace:1",
    workspaceId: "workspace-1",
    shortcut: null,
    windowRef: "window:1",
    windowId: "window-1",
    unread: 0,
    lifecycle: "active",
    model: { id: "gpt-5.6-sol", label: "Sol", provider: "openai", color: "#74AA9C" },
    summary: null,
    suggestion: null,
    membership: null,
    category,
    ...overrides,
  };
}

const noop = (): void => {};
let container: HTMLDivElement;
let root: Root;

function mount(row: SidebarSessionRow): void {
  act(() => {
    root.render(
      <SessionRow
        layouts={{ open: "wide", closed: "wide" }}
        now={2_000}
        onClose={noop}
        onDestroy={noop}
        onDismiss={noop}
        onHover={noop}
        onIncognito={noop}
        onLifecycle={noop}
        onOpen={noop}
        onPin={noop}
        opening={false}
        registerRef={noop}
        row={row}
        selected={false}
        showShortcut={false}
      />,
    );
  });
}

function rightClickTheRow(): void {
  const rowButton = container.querySelector("button");
  if (!rowButton) throw new Error("the row did not render a button to right-click");
  act(() => {
    rowButton.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

const menuItems = (): string[] =>
  [...document.querySelectorAll('[data-slot="context-menu-item"]')].map((item) => item.textContent ?? "");

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

// Present only under the dedicated run; skipping keeps the main suite honest rather than red.
const mounted = typeof document === "undefined" ? describe.skip : describe;

mounted("session row, mounted", () => {
  test("right-clicking opens the menu instead of throwing", () => {
    mount(session());
    rightClickTheRow();

    // The regression this file exists for: a label outside its group threw here and unmounted the
    // tree, so asserting the row survives is as much the point as asserting the menu appeared.
    expect(document.querySelector('[data-slot="context-menu-content"]')).not.toBeNull();
    expect(container.querySelector("button")).not.toBeNull();
    expect(menuItems().length).toBeGreaterThan(0);
  });

  test("every menu label sits inside a group, as Base UI requires at runtime", () => {
    mount(session());
    rightClickTheRow();

    const labels = [...document.querySelectorAll('[data-slot="context-menu-label"]')];
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label.closest('[data-slot="context-menu-group"]')).not.toBeNull();
    }
  });

  test("durable T3 provenance renders as a passive mark", () => {
    mount(session({ t3Associated: true }));
    const mark = [...container.querySelectorAll("span")]
      .find((element) => element.textContent === "T3");
    expect(mark?.getAttribute("title")).toBe("Associated with T3 Code");
  });

  test("the close action appears only on rows that have a tab to close", () => {
    // It used to render disabled on every row, which put a control that could never do anything on
    // all but a handful of a four-hundred row list.
    const closeActions = (): Element[] =>
      [...container.querySelectorAll('[role="button"]')]
        .filter((a) => /Close tab|No tab to close/.test(a.getAttribute("aria-label") ?? ""));

    mount(session({ workspaceRef: "workspace:1" }));
    expect(closeActions()).toHaveLength(1);

    mount(session({ workspaceRef: null, density: "settled" }));
    expect(closeActions()).toHaveLength(0);
  });

  test("an actionable verdict offers both accepting it and dismissing it", () => {
    // Asserted as a pairing rather than by wording: the lifecycle vocabulary is owned elsewhere and
    // has already been renamed once, but a verdict you can act on and cannot decline is the bug.
    mount(session({
      density: "settled",
      lifecycle: "active",
      suggestion: { verb: "archive", actionable: true, reason: "No durable work.", junk: false },
    }));
    rightClickTheRow();

    const items = menuItems();
    expect(items).toContain("Dismiss verdict");
    // The accept sits above the dismiss inside the verdict group, so the group holds both.
    const verdictGroup = document.querySelector('[data-slot="context-menu-group"]');
    expect(verdictGroup?.textContent).toContain("Dismiss verdict");
    expect(verdictGroup?.querySelectorAll('[data-slot="context-menu-item"]').length).toBe(2);
  });
});
