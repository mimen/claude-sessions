import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBridge, parseHookStore } from "./bridge";
import {
  openSessionIdsFrom,
  workspaceForSessionFrom,
  primaryWorkspaceForSessionFrom,
} from "./liveness";

const FIX = join(import.meta.dir, "__fixtures__");
const tree = JSON.parse(readFileSync(join(FIX, "tree.json"), "utf8"));
const store = JSON.parse(readFileSync(join(FIX, "hook-store.json"), "utf8"));
const bridge = buildBridge(tree, store);

const agents = parseHookStore(store);
// pick a binding whose surface is actually live in the tree (the store also holds stale ones)
const liveEntry = [...agents].find(([surfaceId]) => bridge.surfaceToWorkspace.has(surfaceId));
if (!liveEntry) throw new Error("fixture has no live claude surface");
const [firstSurfaceId, firstAgent] = liveEntry;

describe("openSessionIdsFrom", () => {
  const open = openSessionIdsFrom(bridge);

  test("every active binding whose surface is live in the tree is reported open", () => {
    for (const [surfaceId, agent] of agents) {
      if (bridge.surfaceToWorkspace.has(surfaceId)) {
        expect(open.has(agent.sessionId)).toBe(true);
      }
    }
  });

  test("an unknown session id is not open", () => {
    expect(open.has("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

describe("workspaceForSessionFrom", () => {
  test("resolves a live session to its workspace ref (exact, no title/cwd join)", () => {
    const ws = workspaceForSessionFrom(bridge, firstAgent.sessionId);
    expect(ws).not.toBeNull();
    expect(ws!.workspaceRef).toMatch(/^workspace:/);
    expect(ws!.workspaceId).toBeTruthy();
  });

  test("returns null for a closed / unknown session", () => {
    expect(workspaceForSessionFrom(bridge, "nope")).toBeNull();
  });
});

describe("primaryWorkspaceForSessionFrom", () => {
  test("a session that is its workspace's primary is reported as primary", () => {
    // find a workspace whose primary surface is a claude session, use that session
    const loc = bridge.locateSession(firstAgent.sessionId)!;
    const primary = bridge.primarySurface(loc.workspaceId)!;
    const primarySession = bridge.surfaceInfo(primary.surfaceId)!.sessionId;
    const res = primaryWorkspaceForSessionFrom(bridge, primarySession);
    expect(res).not.toBeNull();
    expect(res!.isPrimary).toBe(true);
    expect(res!.workspaceRef).toBe(loc.workspaceRef);
  });
});
