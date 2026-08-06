import {
  isSidebarHttpErrorEnvelope,
  sidebarHttpError,
  type SidebarHttpErrorCode,
} from "../http-error.ts";

const DEFAULT_ACTION_DEADLINE_MS = 8_000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

export type ActionTransportError =
  | { readonly kind: "timeout" }
  | { readonly kind: "connection-refused" }
  | { readonly kind: "malformed-json"; readonly status: number }
  | {
    readonly kind: "server";
    readonly code: SidebarHttpErrorCode;
    readonly status: number;
    readonly retryable: boolean;
  };

export type ActionTransportResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ActionTransportError };

export type ActionFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface ActionTransportOptions {
  readonly deadlineMs?: number;
  readonly fetch?: ActionFetch;
}

function isAbortFailure(cause: object | string): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

export async function postSidebarAction<T extends object>(
  path: string,
  body: JsonObject,
  options: ActionTransportOptions = {},
): Promise<ActionTransportResult<T>> {
  const controller = new AbortController();
  const deadlineMs = options.deadlineMs ?? DEFAULT_ACTION_DEADLINE_MS;
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineMs));
  try {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      return isAbortFailure(cause as object | string)
        ? { ok: false, error: { kind: "timeout" } }
        : { ok: false, error: { kind: "connection-refused" } };
    }

    let parsed: object;
    try {
      const value = (await response.json()) as JsonValue;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { ok: false, error: { kind: "malformed-json", status: response.status } };
      }
      parsed = value;
    } catch (cause) {
      return controller.signal.aborted || isAbortFailure(cause as object | string)
        ? { ok: false, error: { kind: "timeout" } }
        : { ok: false, error: { kind: "malformed-json", status: response.status } };
    }

    if (!response.ok) {
      if (!isSidebarHttpErrorEnvelope(parsed)) {
        return { ok: false, error: { kind: "malformed-json", status: response.status } };
      }
      return {
        ok: false,
        error: {
          kind: "server",
          code: parsed.code,
          status: response.status,
          retryable: parsed.retryable,
        },
      };
    }

    return { ok: true, value: parsed as T };
  } finally {
    clearTimeout(timer);
  }
}

/** Browser-safe copy. It never renders exception text or trusts server-provided implementation text. */
export function actionErrorMessage(error: ActionTransportError): string {
  switch (error.kind) {
    case "timeout":
      return "The action took too long. Check cmux, then try again.";
    case "connection-refused":
      return "The CCS sidebar server is unreachable. Restart the sidebar, then try again.";
    case "malformed-json":
      return "The CCS sidebar returned an invalid response. Restart the sidebar, then try again.";
    case "server":
      return sidebarHttpError(error.code).message;
  }
}
