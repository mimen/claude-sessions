import { describe, expect, test } from "bun:test";
import {
  createCachedStatusReader,
  parseClaudeStatus,
  readClaudeStatuses,
  type CmuxStatusRead,
} from "./status.ts";

describe("parseClaudeStatus", () => {
  test("reads the label, icon, and color cmux publishes", () => {
    expect(parseClaudeStatus("claude_code=Running icon=bolt.fill color=#4C8DFF")).toEqual({
      label: "Running",
      icon: "bolt.fill",
      color: "#4C8DFF",
    });
  });

  test("keeps multi-word labels intact", () => {
    expect(parseClaudeStatus("claude_code=Needs input icon=questionmark color=#E1B46F")).toEqual({
      label: "Needs input",
      icon: "questionmark",
      color: "#E1B46F",
    });
  });

  test("reads a label with no icon or color", () => {
    expect(parseClaudeStatus("claude_code=Idle")).toEqual({ label: "Idle", icon: null, color: null });
  });

  test("finds the claude_code row among other status entries", () => {
    const output = "stage=review icon=eye\nclaude_code=Running icon=bolt.fill color=#4C8DFF\nnext=ship";
    expect(parseClaudeStatus(output)).toMatchObject({ label: "Running" });
  });

  test("returns null when cmux publishes no claude status", () => {
    expect(parseClaudeStatus("No status entries")).toBeNull();
    expect(parseClaudeStatus("stage=review\nnext=ship")).toBeNull();
    expect(parseClaudeStatus("")).toBeNull();
  });

  test("returns null for an empty label rather than an empty pill", () => {
    expect(parseClaudeStatus("claude_code= icon=bolt.fill")).toBeNull();
  });
});

describe("readClaudeStatuses", () => {
  test("targets stable workspace UUIDs and keys results by UUID", async () => {
    const calls: Array<{ readonly args: readonly string[]; readonly binary: string }> = [];
    const statuses = await readClaudeStatuses(
      ["workspace-uuid", "workspace-uuid"],
      "fake-cmux",
      async (args, binary) => {
        calls.push({ args, binary });
        return "claude_code=Running icon=bolt.fill color=#4C8DFF";
      },
    );

    expect(calls).toEqual([{
      args: ["list-status", "--workspace", "workspace-uuid"],
      binary: "fake-cmux",
    }]);
    expect(statuses.get("workspace-uuid")).toEqual({
      state: "published",
      status: { label: "Running", icon: "bolt.fill", color: "#4C8DFF" },
    });
  });

  test("distinguishes no published status from an unreadable list-status command", async () => {
    const absent = await readClaudeStatuses(["absent"], "fake-cmux", async () => "stage=review");
    const unreadable = await readClaudeStatuses(["failed"], "fake-cmux", async () => null);

    expect(absent.get("absent")).toEqual({ state: "absent" });
    expect(unreadable.get("failed")).toEqual({ state: "unreadable" });
  });
});

describe("createCachedStatusReader", () => {
  test("retains stale status after rejection and retries instead of marking the failure fresh", async () => {
    let clock = 100;
    let calls = 0;
    const published = new Map<string, CmuxStatusRead>([[
      "workspace-uuid",
      { state: "published", status: { label: "Running", icon: null, color: null } },
    ]]);
    const reader = createCachedStatusReader(
      "fake-cmux",
      10,
      () => clock,
      () => {
        calls += 1;
        if (calls === 2) return Promise.reject(new Error("cmux unavailable"));
        return Promise.resolve(published);
      },
    );

    await expect(reader.read(["workspace-uuid"])).resolves.toEqual(published);
    clock = 110;
    await expect(reader.read(["workspace-uuid"])).resolves.toEqual(published);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(reader.read(["workspace-uuid"])).resolves.toEqual(published);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(3);
  });
});
