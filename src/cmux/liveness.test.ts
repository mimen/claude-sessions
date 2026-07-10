import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBridge, parsePersisted } from "./bridge";
import {
  openSessionIdsFrom,
  workspaceForSessionFrom,
  primaryWorkspaceForSessionFrom,
} from "./liveness";

const FIX = join(import.meta.dir, "__fixtures__");
const tree = JSON.parse(readFileSync(join(FIX, "tree.json"), "utf8"));
const persisted = JSON.parse(readFileSync(join(FIX, "persisted.json"), "utf8"));
const bridge = buildBridge(tree, persisted);

const agents = parsePersisted(persisted);
const firstEntry = [...agents][0];
if (!firstEntry) throw new Error("fixture has no claude agents");
const [firstSurfaceId, firstAgent] = firstEntry;

describe("openSessionIdsFrom", () => {
  const open = openSessionIdsFrom(bridge);

  test("every persisted claude session with a live surface is reported open", () => {
    // in the fixture, all persisted claude surfaces exist in the tree (25/25), so all are open
    for (const agent of agents.values()) {
      expect(open.has(agent.sessionId)).toBe(true);
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
