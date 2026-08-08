import { describe, expect, test } from "bun:test";
import {
  actionErrorMessage,
  postDeclineSuggestion,
  postSidebarAction,
  type ActionFetch,
} from "./action-transport.ts";

function response(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sidebar action transport", () => {
  test("posts verdict dismissal to the existing decline endpoint", async () => {
    let requestPath = "";
    let requestMethod: string | undefined;
    let requestBody: BodyInit | null | undefined;
    const result = await postDeclineSuggestion<{ readonly status: "ok" }>(
      "session-1",
      "archive",
      {
        fetch: async (path, init) => {
          requestPath = path;
          requestMethod = init.method;
          requestBody = init.body;
          return response('{"status":"ok"}', 200);
        },
      },
    );

    expect(result).toEqual({ ok: true, value: { status: "ok" } });
    expect(requestPath).toBe("/api/session/decline");
    expect(requestMethod).toBe("POST");
    expect(requestBody).toBe(JSON.stringify({ sessionId: "session-1", verb: "archive" }));
  });

  test("keeps timeout and refused connections distinct", async () => {
    const timeoutFetch: ActionFetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("request aborted", "AbortError"));
      });
    });
    const timedOut = await postSidebarAction("/api/open", { sessionId: "one" }, {
      deadlineMs: 1,
      fetch: timeoutFetch,
    });
    expect(timedOut).toEqual({ ok: false, error: { kind: "timeout" } });

    const refused = await postSidebarAction("/api/open", { sessionId: "one" }, {
      fetch: async () => { throw new TypeError("Load failed"); },
    });
    expect(refused).toEqual({ ok: false, error: { kind: "connection-refused" } });
  });

  test("classifies a deadline during response parsing as timeout", async () => {
    const delayedBodyFetch: ActionFetch = async (_input, init) => new Response(new ReadableStream({
      start(controller): void {
        init.signal?.addEventListener("abort", () => {
          controller.error(new DOMException("response body aborted", "AbortError"));
        }, { once: true });
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const result = await postSidebarAction("/api/open", { sessionId: "one" }, {
      deadlineMs: 0,
      fetch: delayedBodyFetch,
    });

    expect(result).toEqual({ ok: false, error: { kind: "timeout" } });
  });

  test("preserves structured 500 and malformed JSON as different failures", async () => {
    const internal = await postSidebarAction("/api/open", { sessionId: "one" }, {
      fetch: async () => response(JSON.stringify({
        code: "internal_failure",
        message: "server-only detail must not be rendered",
        retryable: true,
      }), 500),
    });
    expect(internal).toEqual({
      ok: false,
      error: {
        kind: "server",
        code: "internal_failure",
        status: 500,
        retryable: true,
      },
    });

    const malformed = await postSidebarAction("/api/open", { sessionId: "one" }, {
      fetch: async () => response("not-json", 500),
    });
    expect(malformed).toEqual({
      ok: false,
      error: { kind: "malformed-json", status: 500 },
    });
  });

  test("UI-facing messages never expose WebKit or server exception text", async () => {
    const refused = actionErrorMessage({ kind: "connection-refused" });
    const malformed = actionErrorMessage({ kind: "malformed-json", status: 500 });
    const internal = actionErrorMessage({
      kind: "server",
      code: "internal_failure",
      status: 500,
      retryable: true,
    });

    for (const message of [refused, malformed, internal]) {
      expect(message).not.toContain("TypeError");
      expect(message).not.toContain("Load failed");
      expect(message).not.toContain("/private/catalogue.db");
    }
    expect(refused).toContain("unreachable");
    expect(malformed).toContain("invalid response");
    expect(internal).toContain("internal error");
  });
});
