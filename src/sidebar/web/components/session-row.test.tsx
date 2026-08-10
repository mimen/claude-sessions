/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarCategoryProjection } from "../../category-projection.ts";
import type { SidebarSessionRow } from "../../projection.ts";
import { FullSummary } from "./full-summary.tsx";
import { SessionRow, StatusMetadata } from "./session-row.tsx";

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
    name: "A deliberately long session name that must never wrap onto another line",
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
function renderRow(row: SidebarSessionRow): string {
  return renderToStaticMarkup(
    <SessionRow
      now={2_000}
      onClose={noop}
      onDismiss={noop}
      onHover={noop}
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
}

describe("session row layout", () => {
  test("has one fixed-height title line and overlays hover actions without removing metadata", () => {
    const markup = renderRow(session());
    expect(markup).toContain("h-[46px]");
    expect(markup).toContain("truncate text-[13px]");
    expect(markup).toContain('data-row-actions-overlay="true"');
    // Absolute keeps the actions out of layout, which is what makes hover reflow-free. They
    // anchor right and overhang leftward over the name, so the metadata beside them is free to
    // take only the width it needs instead of reserving room for the longest possible status.
    expect(markup).toContain("absolute inset-y-0 right-0");
    expect(markup).toContain("group-hover:opacity-100");
    expect(markup).not.toContain("line-clamp-2");
    expect(markup).not.toContain("group-hover:hidden");
    // The metadata itself survives the overlay rather than being swapped out on hover.
    expect(markup).toContain("Waiting");
    // A fixed metadata slot is what stranded 55 to 88px next to a truncated name.
    expect(markup).not.toContain("w-[132px] shrink-0");
    // The slot is the overlay's positioning context, so a short slot fades a band across the
    // row's middle instead of the whole row.
    expect(markup).toContain("relative flex h-full shrink-0");
    expect(markup).not.toContain("relative flex h-5 shrink-0");
  });

  test("a closed session keeps the live layout and drops only what stopped being true", () => {
    const markup = renderRow(session({ density: "settled", lifecycle: "completed" }));

    // Same grid as a live row, so names stay in one column down the whole list.
    expect(markup).toContain("h-[46px]");
    expect(markup).toContain("truncate text-[13px]");
    // No card. The row draws itself only under the pointer. Matched with the preceding class so
    // the assertion cannot pass on the left edge's own `before:bg-transparent`.
    expect(markup).toContain("duration-75 bg-transparent");
    expect(markup).not.toContain("duration-75 bg-card");
    expect(markup).toContain("hover:bg-secondary");
    // Model and status describe a running process, so a closed row must not claim either.
    expect(markup).not.toContain("Sol");
    expect(markup).not.toContain("Waiting");
    // What still holds is still shown.
    expect(markup).toContain("claude-sessions");
    expect(markup).toContain('data-row-actions-overlay="true"');
    expect(markup).toContain("relative flex h-full shrink-0");
  });

  test("a live session keeps its card, model and status", () => {
    const markup = renderRow(session());
    expect(markup).toContain("duration-75 bg-card");
    expect(markup).not.toContain("duration-75 bg-transparent");
    expect(markup).toContain("Sol");
    expect(markup).toContain("Waiting");
  });

  test("the metadata line names the category and the project, and shows no vendor logo", () => {
    const markup = renderRow(session());

    // Short label beside the dot, so colour is recognition rather than the only encoding.
    expect(markup).toContain("Events");
    expect(markup).not.toContain("Events, Booking &amp; Live Production</span> ·");
    // The full wording stays for screen readers.
    expect(markup).toContain("Category: Events, Booking &amp; Live Production.");

    // Project identity is a glyph plus a name. With no published favicon it falls back to a folder.
    expect(markup).toContain("claude-sessions");

    // The model is named but not badged: the label is already tinted by vendor.
    expect(markup).toContain("Sol");
    expect(markup).not.toContain("inline-flex size-3");
  });

  test("titles carry one step of weight, not semibold", () => {
    const needsYou = renderRow(session({ section: "needs-you" }));
    expect(needsYou).toContain("font-medium");
    expect(needsYou).not.toContain("font-semibold");

    // One step below, so the two stay separable without either being heavy.
    const working = renderRow(session({ section: "working" }));
    expect(working).toContain("font-normal");
    expect(working).not.toContain("font-medium");
  });

  test("focused edge wins over unread blue", () => {
    const focused = renderRow(session({ focused: true, unread: 4 }));
    expect(focused).toContain("before:bg-primary");
    expect(focused).not.toContain("before:bg-[#4C8DFF]");
    expect(focused).toContain("4 unread");

    const unread = renderRow(session({ focused: false, unread: 4 }));
    expect(unread).toContain("before:bg-[#4C8DFF]");
  });

  test("junk removes saturation without stacking opacity or showing a junk tag", () => {
    const row = session({
      density: "settled",
      summary: {
        state: "Generated by a stray probe.",
        history: null,
        next: null,
        remaining: null,
        recommendation: "archive",
        reason: "No durable work was started.",
        junk: true,
        atMessages: 2,
        at: "2026-08-01T00:00:00Z",
        declined: null,
        driftLabel: null,
        messagesSince: 0,
      },
      suggestion: {
        verb: "archive",
        actionable: true,
        reason: "No durable work was started.",
        junk: true,
      },
    });
    const markup = renderRow(row);
    expect(markup).toContain('data-junk="true"');
    expect(markup).toContain("grayscale");
    expect(markup).toContain("text-neutral-300");
    expect(markup).not.toContain("opacity-60");
    expect(markup).not.toContain(">junk<");
    expect(markup).toContain("Junk session. Archive recommended.");
  });
});

describe("session row status", () => {
  test("renders no not-live label but keeps unreadable and absent distinct", () => {
    expect(renderToStaticMarkup(<StatusMetadata availability="not-live" status={null} />)).toBe("");

    const unreadable = renderToStaticMarkup(
      <StatusMetadata availability="unreadable" status={null} />,
    );
    expect(unreadable).toContain("Status unavailable");
    expect(unreadable).toContain("--action-shelve");

    const absent = renderToStaticMarkup(<StatusMetadata availability="absent" status={null} />);
    expect(absent).toContain("Live");
    expect(absent).not.toContain("Status unavailable");
  });
});

describe("full summary menu content", () => {
  test("shows every enrichment field, category, and honest staleness", () => {
    const markup = renderToStaticMarkup(
      <FullSummary
        category={category}
        summary={{
          state: "Implementing the sidebar row.",
          history: "Mockups settled Option 2.",
          next: "Run the full suite.",
          remaining: "Commit and push.",
          recommendation: "complete",
          reason: "Ready after verification.",
          junk: false,
          atMessages: 100,
          at: "2026-08-01T00:00:00Z",
          declined: null,
          driftLabel: "23 messages since summary",
          messagesSince: 23,
        }}
      />,
    );
    for (const text of [
      "Events, Booking &amp; Live Production",
      "Recommendation",
      "complete",
      "Reason",
      "Ready after verification.",
      "Staleness",
      "23 messages since summary",
      "State",
      "Implementing the sidebar row.",
      "Next",
      "Run the full suite.",
      "Remaining",
      "Commit and push.",
      "History",
      "Mockups settled Option 2.",
    ]) expect(markup).toContain(text);
    expect(markup.toLowerCase()).not.toContain("current");
  });
});
