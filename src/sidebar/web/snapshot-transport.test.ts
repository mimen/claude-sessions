import { describe, expect, test } from "bun:test";
import type { SidebarSnapshot } from "../projection.ts";
import { createSnapshotTransport, snapshotPollDelay } from "./snapshot-transport.ts";

const SNAPSHOT: SidebarSnapshot = {
  rows: [],
  livenessReadable: true,
  indexReadable: true,
  catalogueReadable: true,
  lifecycleCounts: { active: 0, completed: 0, archived: 0 },
  hasMoreRows: false,
  generatedAt: 0,
};

function jsonResponse(body: object, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("snapshot transport", () => {
  test("retains an ETag and treats 304 as unchanged", async () => {
    const headers: Array<string | null> = [];
    let calls = 0;
    const transport = createSnapshotTransport({
      fetch: (async (_input, init) => {
        headers.push(new Headers(init?.headers).get("if-none-match"));
        calls += 1;
        return calls === 1
          ? jsonResponse(SNAPSHOT, { headers: { etag: '"revision-1"' } })
          : new Response(null, { status: 304 });
      }),
    });

    expect((await transport.load("/api/snapshot")).kind).toBe("changed");
    expect(await transport.load("/api/snapshot")).toEqual({ kind: "unchanged" });
    expect(headers).toEqual([null, '"revision-1"']);
  });

  test("an older server without ETag stays on ordinary 200 responses", async () => {
    const headers: Array<string | null> = [];
    const transport = createSnapshotTransport({
      fetch: (async (_input, init) => {
        headers.push(new Headers(init?.headers).get("if-none-match"));
        return jsonResponse(SNAPSHOT);
      }),
    });

    expect((await transport.load("/api/snapshot")).kind).toBe("changed");
    expect((await transport.load("/api/snapshot")).kind).toBe("changed");
    expect(headers).toEqual([null, null]);
  });

  test("keeps deadline, refused, HTTP, and malformed failures distinct", async () => {
    const deadline = createSnapshotTransport({
      deadlineMs: 5,
      fetch: ((_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })),
    });
    const refused = createSnapshotTransport({
      fetch: (async () => { throw new TypeError("Load failed"); }),
    });
    const serverError = createSnapshotTransport({
      fetch: (async () => jsonResponse({ error: "no" }, { status: 500 })),
    });
    const malformed = createSnapshotTransport({
      fetch: (async () => new Response("not json", { status: 200 })),
    });
    const wrongShape = createSnapshotTransport({
      fetch: (async () => new Response("null", { status: 200 })),
    });

    expect(await deadline.load("/api/snapshot")).toEqual({
      kind: "failure",
      error: { kind: "deadline", message: "Sidebar refresh timed out." },
    });
    expect(await refused.load("/api/snapshot")).toEqual({
      kind: "failure",
      error: { kind: "refused", message: "Sidebar server is not accepting connections." },
    });
    expect(await serverError.load("/api/snapshot")).toEqual({
      kind: "failure",
      error: { kind: "http", status: 500, message: "Sidebar refresh failed with HTTP 500." },
    });
    expect(await malformed.load("/api/snapshot")).toEqual({
      kind: "failure",
      error: { kind: "malformed", message: "Sidebar server returned an invalid snapshot." },
    });
    expect(await wrongShape.load("/api/snapshot")).toEqual({
      kind: "failure",
      error: { kind: "malformed", message: "Sidebar server returned an invalid snapshot." },
    });
  });

  test("backs off only consecutive failures", () => {
    expect(snapshotPollDelay(0)).toBe(1_000);
    expect(snapshotPollDelay(1)).toBe(2_000);
    expect(snapshotPollDelay(2)).toBe(4_000);
    expect(snapshotPollDelay(10)).toBe(30_000);
  });
});
