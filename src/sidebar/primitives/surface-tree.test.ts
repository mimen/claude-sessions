import { describe, expect, test } from "bun:test";
import {
  createSurfaceTreeReader,
  identityOf,
  parseSurfaceTree,
} from "./surface-tree.ts";
import type { SurfaceLocation } from "../../cmux/bridge.ts";

function loc(overrides: Partial<SurfaceLocation> & Pick<SurfaceLocation, "surfaceId" | "workspaceId">): SurfaceLocation {
  return {
    surfaceRef: "s:1",
    surfaceType: "terminal",
    title: null,
    paneId: "p",
    paneIndex: 0,
    indexInPane: 0,
    workspaceRef: "workspace:1",
    workspaceTitle: null,
    windowId: "w",
    windowRef: "window:1",
    ...overrides,
  };
}

describe("parseSurfaceTree", () => {
  test("rejects unparseable JSON fail-closed", () => {
    expect(parseSurfaceTree("{")).toBeNull();
    expect(parseSurfaceTree("")).toBeNull();
  });

  test("empty tree is readable with no surfaces", () => {
    const parsed = parseSurfaceTree(JSON.stringify({ windows: [] }));
    expect(parsed).not.toBeNull();
    expect(parsed?.readable).toBe(true);
    expect(parsed?.surfaces).toEqual([]);
    expect(parsed?.focusedWorkspaceId).toBeNull();
  });

  test("extracts surfaces in tree order and the focused workspace", () => {
    const raw = JSON.stringify({
      windows: [
        {
          id: "W",
          ref: "window:1",
          workspaces: [
            {
              id: "WS-A",
              ref: "workspace:1",
              title: "Alpha",
              active: false,
              panes: [
                {
                  id: "P",
                  surfaces: [{ id: "S-A", ref: "s:1", title: "tab-a", index_in_pane: 0 }],
                },
              ],
            },
            {
              id: "WS-B",
              ref: "workspace:2",
              title: "Beta",
              active: true,
              panes: [
                {
                  id: "P2",
                  surfaces: [{ id: "S-B", ref: "s:2", title: "tab-b", index_in_pane: 0 }],
                },
              ],
            },
          ],
        },
      ],
    });
    const parsed = parseSurfaceTree(raw);
    expect(parsed?.surfaces.map((s) => s.surfaceId)).toEqual(["S-A", "S-B"]);
    expect(parsed?.focusedWorkspaceId).toBe("WS-B");
    expect(parsed?.workspaceIds.has("WS-A")).toBe(true);
  });
});

describe("identityOf / revision", () => {
  test("identical trees share identity", () => {
    const a = [loc({ surfaceId: "S", workspaceId: "W", title: "t" })];
    const b = [loc({ surfaceId: "S", workspaceId: "W", title: "t" })];
    expect(identityOf(a)).toBe(identityOf(b));
  });

  test("a title or focus change is a new identity", () => {
    const a = [loc({ surfaceId: "S", workspaceId: "W", title: "t", workspaceSelected: false })];
    const b = [loc({ surfaceId: "S", workspaceId: "W", title: "t!", workspaceSelected: false })];
    const c = [loc({ surfaceId: "S", workspaceId: "W", title: "t", workspaceSelected: true })];
    expect(identityOf(a)).not.toBe(identityOf(b));
    expect(identityOf(a)).not.toBe(identityOf(c));
  });

  test("failed reads never advance revision", async () => {
    let n = 0;
    const reader = createSurfaceTreeReader({
      runTree: async () => {
        n += 1;
        if (n === 1) return JSON.stringify({ windows: [] });
        return null;
      },
    });
    const first = await reader.read();
    expect(first.readable).toBe(true);
    expect(first.revision).toBe(1);
    const failed = await reader.read();
    expect(failed.readable).toBe(false);
    expect(failed.revision).toBe(1);
    const torn = createSurfaceTreeReader({ runTree: async () => "{" });
    const t = await torn.read();
    expect(t.readable).toBe(false);
    expect(t.revision).toBe(0);
  });

  test("unchanged payload does not bump revision", async () => {
    const payload = JSON.stringify({ windows: [] });
    const reader = createSurfaceTreeReader({ runTree: async () => payload });
    const a = await reader.read();
    const b = await reader.read();
    expect(a.revision).toBe(b.revision);
  });
});
