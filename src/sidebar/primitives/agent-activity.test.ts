import { describe, expect, test } from "bun:test";
import { createAgentActivityReader, type ActivityObservation } from "./agent-activity.ts";
import type { CmuxStatusRead } from "../status.ts";

function obs(workspaceId: string, agentLifecycle: string | null = null): ActivityObservation {
  return { workspaceId, agentLifecycle };
}

function published(label: string): CmuxStatusRead {
  return { state: "published", status: { label, icon: null, color: null } };
}

describe("createAgentActivityReader", () => {
  test("published beats derived", async () => {
    const reader = createAgentActivityReader({
      sweep: async (ids) => new Map(ids.map((id) => [id, published("Needs input")])),
    });
    const read = await reader.read([obs("W", "running")]);
    expect(read.byWorkspace.get("W")).toEqual({
      state: "published",
      status: { label: "Needs input", icon: null, color: null },
    });
  });

  test("derived fills the gap when the sweep is absent", async () => {
    const reader = createAgentActivityReader({
      sweep: async (ids) => new Map(ids.map((id) => [id, { state: "absent" as const }])),
    });
    const read = await reader.read([obs("W", "needsInput")]);
    expect(read.byWorkspace.get("W")?.state).toBe("derived");
    expect(read.byWorkspace.get("W")?.status?.label).toBe("Needs input");
  });

  test("absent with no derivable lifecycle stays absent, not invented", async () => {
    const reader = createAgentActivityReader({
      sweep: async (ids) => new Map(ids.map((id) => [id, { state: "absent" as const }])),
    });
    const read = await reader.read([obs("W", "unknown")]);
    expect(read.byWorkspace.get("W")).toEqual({ state: "absent", status: null });
  });

  test("a totally unreadable sweep retains the last good map with a frozen revision", async () => {
    let fail = false;
    const reader = createAgentActivityReader({
      sweep: async (ids) => {
        if (fail) return new Map(ids.map((id) => [id, { state: "unreadable" as const }]));
        return new Map(ids.map((id) => [id, published("Running")]));
      },
    });
    const good = await reader.read([obs("W")]);
    expect(good.revision).toBe(1);
    fail = true;
    const retained = await reader.read([obs("W")]);
    expect(retained.revision).toBe(1);
    expect(retained.byWorkspace.get("W")?.status?.label).toBe("Running");
  });

  test("a label change bumps revision; an identical repeat does not", async () => {
    let label = "Running";
    const reader = createAgentActivityReader({
      sweep: async (ids) => new Map(ids.map((id) => [id, published(label)])),
    });
    const a = await reader.read([obs("W")]);
    const b = await reader.read([obs("W")]);
    expect(b.revision).toBe(a.revision);
    label = "Needs input";
    const c = await reader.read([obs("W")]);
    expect(c.revision).toBe(a.revision + 1);
    expect(c.byWorkspace.get("W")?.status?.label).toBe("Needs input");
  });

  test("an unreadable minority among readable workspaces is labelled per row", async () => {
    const reader = createAgentActivityReader({
      sweep: async () => new Map([
        ["W-OK", published("Running")],
        ["W-DEAD", { state: "unreadable" as const }],
      ]),
    });
    const read = await reader.read([obs("W-OK", "running"), obs("W-DEAD", null)]);
    expect(read.byWorkspace.get("W-OK")?.status?.label).toBe("Running");
    expect(read.byWorkspace.get("W-DEAD")).toEqual({ state: "unreadable", status: null });
  });
});
