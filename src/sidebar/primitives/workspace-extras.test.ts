import { describe, expect, test } from "bun:test";
import { createWorkspaceExtrasReader } from "./workspace-extras.ts";
import type { CmuxNotificationState } from "../notifications.ts";
import type { WorkspaceState } from "../workspace-state.ts";

function notifications(unread: Record<string, number>): CmuxNotificationState {
  return { notifications: [], unreadCountsByWorkspaceId: new Map(Object.entries(unread)) };
}

function state(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    branch: "main",
    dirty: false,
    pr: null,
    ports: [],
    progress: null,
    color: null,
    cwd: "/tmp",
    ...overrides,
  };
}

describe("createWorkspaceExtrasReader", () => {
  test("composes unread counts and workspace states", async () => {
    const reader = createWorkspaceExtrasReader({
      readNotifications: async () => notifications({ "W-1": 2 }),
      readWorkspaceStates: async (ids) => new Map(ids.map((id) => [id, state({ branch: "feat" })])),
    });
    const read = await reader.read(["W-1"]);
    expect(read.unreadByWorkspaceId.get("W-1")).toBe(2);
    expect(read.stateByWorkspaceId.get("W-1")?.branch).toBe("feat");
    expect(read.revision).toBe(1);
  });

  test("an unread bump is a change; an identical repeat is not", async () => {
    let unread = { "W-1": 0 };
    const reader = createWorkspaceExtrasReader({
      readNotifications: async () => notifications(unread),
      readWorkspaceStates: async (ids) => new Map(ids.map((id) => [id, state()])),
    });
    const a = await reader.read(["W-1"]);
    const b = await reader.read(["W-1"]);
    expect(b.revision).toBe(a.revision);
    unread = { "W-1": 3 };
    const c = await reader.read(["W-1"]);
    expect(c.revision).toBe(a.revision + 1);
    expect(c.unreadByWorkspaceId.get("W-1")).toBe(3);
  });

  test("a branch flip is a change even when unread is stable", async () => {
    let branch = "main";
    const reader = createWorkspaceExtrasReader({
      readNotifications: async () => notifications({}),
      readWorkspaceStates: async (ids) => new Map(ids.map((id) => [id, state({ branch })])),
    });
    const a = await reader.read(["W-1"]);
    branch = "feat-x";
    const b = await reader.read(["W-1"]);
    expect(b.revision).toBe(a.revision + 1);
  });

  test("a failed state read degrades to nulls without throwing", async () => {
    const reader = createWorkspaceExtrasReader({
      readNotifications: async () => notifications({ "W-1": 1 }),
      readWorkspaceStates: async () => {
        throw new Error("cmux down");
      },
    });
    await expect(reader.read(["W-1"])).rejects.toThrow("cmux down");
  });

  test("empty workspace list skips the state sweep but still reads notifications", async () => {
    let stateCalls = 0;
    const reader = createWorkspaceExtrasReader({
      readNotifications: async () => notifications({}),
      readWorkspaceStates: async (ids) => {
        stateCalls += 1;
        return new Map(ids.map((id) => [id, null]));
      },
    });
    await reader.read([]);
    expect(stateCalls).toBe(0);
  });
});
