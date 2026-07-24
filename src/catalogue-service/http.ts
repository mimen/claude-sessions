import { z } from "zod";
import type { CatalogueAuthority, CatalogueAuthorityError } from "./authority.ts";
import {
  CATALOGUE_PROTOCOL_VERSION,
  RootSessionQuerySchema,
  SourceLookupSchema,
  type CatalogueErrorCode,
  type CatalogueHealthResult,
  type CatalogueMutationResult,
  type CatalogueProtocolError,
  type CatalogueShutdownResult,
  type SourceStatusResult,
} from "./protocol.ts";

const ControlRefreshSchema = z
  .object({
    force: z.boolean().default(false),
    titles: z.boolean().default(false),
  })
  .strict();
const ControlSaveTitleSchema = z
  .object({ sessionId: z.string().min(1).max(256), title: z.string().min(1).max(500) })
  .strict();
const ControlTitleFailureSchema = z
  .object({ sessionId: z.string().min(1).max(256) })
  .strict();

export interface CatalogueHttpOptions {
  readonly authority: CatalogueAuthority;
  readonly service: CatalogueHealthResult["service"];
  readonly onRequestStart?: () => void;
  readonly onRequestEnd?: () => void;
  readonly onShutdown: () => void;
}

function statusFor(code: CatalogueErrorCode): number {
  switch (code) {
    case "bad_request":
    case "invalid_resume_id":
    case "invalid_cwd":
      return 400;
    case "source_not_found":
    case "not_found":
      return 404;
    case "source_ambiguous":
    case "cwd_mismatch":
    case "source_changed":
    case "stale_cursor":
      return 409;
    case "refresh_failed":
      return 503;
    case "internal_error":
      return 500;
  }
}

function json(body: object, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function failure(error: CatalogueAuthorityError): Response {
  const body: CatalogueProtocolError = {
    protocolVersion: CATALOGUE_PROTOCOL_VERSION,
    error,
  };
  return json(body, statusFor(error.code));
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 64 * 1024) return null;
  const text = await request.text();
  return text.length <= 64 * 1024 ? text : null;
}

/** Versioned read API plus private lifecycle controls, served only on a user-private Unix socket. */
export function createCatalogueHttpHandler(options: CatalogueHttpOptions): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    options.onRequestStart?.();
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const prepared = await options.authority.prepareRead(false, {
          startBackground: false,
          waitForInFlight: true,
        });
        if (!prepared.ok) return failure(prepared.error);
        const body: CatalogueHealthResult = {
          protocolVersion: CATALOGUE_PROTOCOL_VERSION,
          service: options.service,
          sourceStatus: prepared.value,
        };
        return json(body);
      }

      if (request.method === "GET" && url.pathname === "/v1/source-status") {
        const prepared = await options.authority.prepareRead(false);
        if (!prepared.ok) return failure(prepared.error);
        const body: SourceStatusResult = {
          protocolVersion: CATALOGUE_PROTOCOL_VERSION,
          sourceStatus: prepared.value,
        };
        return json(body);
      }

      if (request.method === "POST" && url.pathname === "/v1/root-sessions/query") {
        const text = await readBody(request);
        if (text === null) return failure({ code: "bad_request", message: "Request body is too large." });
        let parsedJson: object;
        try {
          parsedJson = text.trim() === "" ? {} : JSON.parse(text) as object;
        } catch {
          return failure({ code: "bad_request", message: "Request body must be valid JSON." });
        }
        const parsed = RootSessionQuerySchema.safeParse(parsedJson);
        if (!parsed.success) {
          return failure({ code: "bad_request", message: z.prettifyError(parsed.error) });
        }
        const result = await options.authority.query(parsed.data);
        return result.ok ? json(result.value) : failure(result.error);
      }

      if (request.method === "POST" && url.pathname === "/v1/source/lookup") {
        const text = await readBody(request);
        if (text === null) return failure({ code: "bad_request", message: "Request body is too large." });
        let parsedJson: object;
        try {
          parsedJson = text.trim() === "" ? {} : JSON.parse(text) as object;
        } catch {
          return failure({ code: "bad_request", message: "Request body must be valid JSON." });
        }
        const parsed = SourceLookupSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return failure({ code: "bad_request", message: z.prettifyError(parsed.error) });
        }
        const result = await options.authority.lookup(parsed.data.resumeId, parsed.data.cwd);
        return result.ok ? json(result.value) : failure(result.error);
      }

      if (request.method === "POST" && url.pathname === "/_control/refresh") {
        const text = await readBody(request);
        if (text === null) return failure({ code: "bad_request", message: "Request body is too large." });
        let parsedJson: object;
        try {
          parsedJson = text.trim() === "" ? {} : JSON.parse(text) as object;
        } catch {
          return failure({ code: "bad_request", message: "Request body must be valid JSON." });
        }
        const parsed = ControlRefreshSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return failure({ code: "bad_request", message: z.prettifyError(parsed.error) });
        }
        const result = await options.authority.controlRefresh(parsed.data);
        return result.ok ? json(result.value) : failure(result.error);
      }

      if (request.method === "POST" && url.pathname === "/_control/title") {
        const text = await readBody(request);
        if (text === null) return failure({ code: "bad_request", message: "Request body is too large." });
        let parsedJson: object;
        try {
          parsedJson = text.trim() === "" ? {} : JSON.parse(text) as object;
        } catch {
          return failure({ code: "bad_request", message: "Request body must be valid JSON." });
        }
        const parsed = ControlSaveTitleSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return failure({ code: "bad_request", message: z.prettifyError(parsed.error) });
        }
        const saved = await options.authority.saveTitle(parsed.data.sessionId, parsed.data.title);
        if (!saved.ok) return failure(saved.error);
        const body: CatalogueMutationResult = {
          protocolVersion: CATALOGUE_PROTOCOL_VERSION,
          saved: true,
        };
        return json(body);
      }

      if (request.method === "POST" && url.pathname === "/_control/title-failure") {
        const text = await readBody(request);
        if (text === null) return failure({ code: "bad_request", message: "Request body is too large." });
        let parsedJson: object;
        try {
          parsedJson = text.trim() === "" ? {} : JSON.parse(text) as object;
        } catch {
          return failure({ code: "bad_request", message: "Request body must be valid JSON." });
        }
        const parsed = ControlTitleFailureSchema.safeParse(parsedJson);
        if (!parsed.success) {
          return failure({ code: "bad_request", message: z.prettifyError(parsed.error) });
        }
        const saved = await options.authority.recordTitleFailure(parsed.data.sessionId);
        if (!saved.ok) return failure(saved.error);
        const body: CatalogueMutationResult = {
          protocolVersion: CATALOGUE_PROTOCOL_VERSION,
          saved: true,
        };
        return json(body);
      }

      if (request.method === "POST" && url.pathname === "/_control/shutdown") {
        const body: CatalogueShutdownResult = {
          protocolVersion: CATALOGUE_PROTOCOL_VERSION,
          stopping: true,
        };
        queueMicrotask(options.onShutdown);
        return json(body);
      }

      return failure({ code: "not_found", message: "Catalogue protocol route not found." });
    } catch {
      return failure({ code: "internal_error", message: "Catalogue service request failed." });
    } finally {
      options.onRequestEnd?.();
    }
  };
}
