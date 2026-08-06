import { describe, expect, test } from "bun:test";
import {
  createCachedNotificationReader,
  parseNotifications,
  readNotifications,
  type CmuxNotificationState,
} from "./notifications.ts";

const CAPTURED_NOTIFICATIONS = [
  "0:48F04283-208E-4AC1-9F3E-5D9FE15769E5|185B8DBD-8710-488A-9978-49506FB68869|F1260E79-D0CA-4D3A-9AAB-6B583AB96187|unread|Claude Code|Waiting|Claude is waiting for your input|2026-07-25T06:27:59Z|pct:Messaging App CRM",
  "1:B0AAA0E3-874F-4B59-B56E-A5B5C2551257|E4AEB44D-3616-41D3-B711-094DA4ED1F82|08D2AF91-3489-4B29-82DF-01F87336B4B6|read|Claude Code|Waiting|Claude is waiting for your input|2026-07-25T01:04:34Z|pct:Reduce idle session RAM usage",
].join("\n");

function expectEmpty(state: CmuxNotificationState): void {
  expect(state.notifications).toEqual([]);
  expect(state.unreadCountsByWorkspaceId).toEqual(new Map());
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

describe("parseNotifications", () => {
  test("parses captured cmux output and counts unread notifications by workspace UUID", () => {
    const state = parseNotifications(CAPTURED_NOTIFICATIONS);

    expect(state.notifications).toEqual([
      {
        index: 0,
        id: "48F04283-208E-4AC1-9F3E-5D9FE15769E5",
        workspaceId: "185B8DBD-8710-488A-9978-49506FB68869",
        surfaceId: "F1260E79-D0CA-4D3A-9AAB-6B583AB96187",
        readState: { state: "unread" },
        source: "Claude Code",
        title: "Waiting",
        body: "Claude is waiting for your input",
        timestamp: "2026-07-25T06:27:59Z",
        workspaceTitle: "Messaging App CRM",
      },
      {
        index: 1,
        id: "B0AAA0E3-874F-4B59-B56E-A5B5C2551257",
        workspaceId: "E4AEB44D-3616-41D3-B711-094DA4ED1F82",
        surfaceId: "08D2AF91-3489-4B29-82DF-01F87336B4B6",
        readState: { state: "read" },
        source: "Claude Code",
        title: "Waiting",
        body: "Claude is waiting for your input",
        timestamp: "2026-07-25T01:04:34Z",
        workspaceTitle: "Reduce idle session RAM usage",
      },
    ]);
    expect(state.unreadCountsByWorkspaceId).toEqual(new Map([
      ["185B8DBD-8710-488A-9978-49506FB68869", 1],
    ]));
  });

  test("counts several unread notifications for the same workspace", () => {
    const repeatedUnread = CAPTURED_NOTIFICATIONS.split("\n")[0];
    if (!repeatedUnread) throw new Error("captured fixture is empty");
    const secondUnread = repeatedUnread
      .replace("0:48F04283-208E-4AC1-9F3E-5D9FE15769E5", "2:219BC655-ECD3-4BDB-8D7E-D5A3181E11B2")
      .replace("2026-07-25T06:27:59Z", "2026-07-25T06:28:59Z");

    const state = parseNotifications(`${repeatedUnread}\n${secondUnread}`);

    expect(state.unreadCountsByWorkspaceId.get("185B8DBD-8710-488A-9978-49506FB68869"))
      .toBe(2);
  });

  test("preserves unrecognised read-state tokens as unknown and does not count them as unread", () => {
    const output = CAPTURED_NOTIFICATIONS
      .split("\n")[0]
      ?.replace("|unread|", "|dismissed|");
    if (!output) throw new Error("captured fixture is empty");

    const state = parseNotifications(output);

    expect(state.notifications[0]?.readState).toEqual({ state: "unknown", token: "dismissed" });
    expect(state.unreadCountsByWorkspaceId.has("185B8DBD-8710-488A-9978-49506FB68869"))
      .toBe(false);
  });

  test("returns empty state for an empty notification list", () => {
    expectEmpty(parseNotifications(""));
    expectEmpty(parseNotifications("\n  \n"));
  });

  test("returns empty state when any non-empty line is malformed", () => {
    const validLine = CAPTURED_NOTIFICATIONS.split("\n")[0];
    if (!validLine) throw new Error("captured fixture is empty");
    const malformedOutputs = [
      "not-a-notification",
      validLine.replace("185B8DBD-8710-488A-9978-49506FB68869", "not-a-workspace-uuid"),
      validLine.replace("2026-07-25T06:27:59Z", "not-a-timestamp"),
      `${validLine}\nmissing|fields`,
    ];

    for (const output of malformedOutputs) expectEmpty(parseNotifications(output));
  });
});

describe("readNotifications", () => {
  test("uses one list-notifications subprocess for the whole state", async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly binary: string }> = [];

    const state = await readNotifications("fake-cmux", async (args, binary) => {
      calls.push({ args, binary });
      return CAPTURED_NOTIFICATIONS;
    });

    expect(calls).toEqual([{ args: ["list-notifications"], binary: "fake-cmux" }]);
    expect(state.notifications).toHaveLength(2);
  });

  test("degrades command failures and thrown runner errors to empty state", async () => {
    expectEmpty(await readNotifications("fake-cmux", async () => null));
    expectEmpty(await readNotifications("fake-cmux", async () => {
      throw new Error("cmux unavailable");
    }));
  });
});

describe("createCachedNotificationReader", () => {
  test("returns immediately from an empty cache and coalesces the background refresh", async () => {
    const populated = parseNotifications(CAPTURED_NOTIFICATIONS);
    const pendingRead = deferred<CmuxNotificationState>();
    let calls = 0;
    const reader = createCachedNotificationReader(
      "fake-cmux",
      1_000,
      () => 100,
      () => {
        calls += 1;
        return pendingRead.promise;
      },
    );

    expectEmpty(await reader.read());
    expectEmpty(await reader.read());
    expect(calls).toBe(1);

    pendingRead.resolve(populated);
    await pendingRead.promise;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect((await reader.read()).unreadCountsByWorkspaceId).toEqual(
      populated.unreadCountsByWorkspaceId,
    );
    expect(calls).toBe(1);
  });

  test("maps a cached loader failure to empty state", async () => {
    const reader = createCachedNotificationReader(
      "fake-cmux",
      1_000,
      () => 100,
      () => {
        throw new Error("unexpected notification failure");
      },
    );

    expectEmpty(await reader.read());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expectEmpty(await reader.read());
  });
});
