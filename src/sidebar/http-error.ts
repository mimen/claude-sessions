export type SidebarHttpErrorCode =
  | "bad_request"
  | "denied"
  | "not_found"
  | "liveness_unreadable"
  | "catalogue_unreadable"
  | "index_unreadable"
  | "timeout"
  | "action_failed"
  | "internal_failure";

export interface SidebarHttpErrorEnvelope {
  readonly code: SidebarHttpErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

interface SidebarHttpErrorDefinition extends SidebarHttpErrorEnvelope {
  readonly status: number;
}

const DEFINITIONS: Readonly<Record<SidebarHttpErrorCode, SidebarHttpErrorDefinition>> = {
  bad_request: {
    code: "bad_request",
    message: "The request was invalid. Refresh the sidebar and try again.",
    retryable: false,
    status: 400,
  },
  denied: {
    code: "denied",
    message: "The sidebar rejected this request. Reload it from the local CCS server.",
    retryable: false,
    status: 403,
  },
  not_found: {
    code: "not_found",
    message: "That session or workspace no longer exists. Refresh the list.",
    retryable: false,
    status: 404,
  },
  liveness_unreadable: {
    code: "liveness_unreadable",
    message: "cmux state is unavailable. Check cmux, then try again.",
    retryable: true,
    status: 503,
  },
  catalogue_unreadable: {
    code: "catalogue_unreadable",
    message: "The session catalogue is unavailable. Retry after CCS finishes its current write.",
    retryable: true,
    status: 503,
  },
  index_unreadable: {
    code: "index_unreadable",
    message: "The session index is unavailable. Run a CCS refresh, then try again.",
    retryable: true,
    status: 503,
  },
  timeout: {
    code: "timeout",
    message: "The action timed out. Check cmux, then try again.",
    retryable: true,
    status: 504,
  },
  action_failed: {
    code: "action_failed",
    message: "CCS could not complete that action. Refresh the list and try again.",
    retryable: true,
    status: 409,
  },
  internal_failure: {
    code: "internal_failure",
    message: "The sidebar hit an internal error. Retry once, then restart the CCS sidebar if it persists.",
    retryable: true,
    status: 500,
  },
};

export function sidebarHttpError(code: SidebarHttpErrorCode): SidebarHttpErrorDefinition {
  return DEFINITIONS[code];
}

export function isSidebarHttpErrorEnvelope(value: object): value is SidebarHttpErrorEnvelope {
  const candidate = value as Partial<SidebarHttpErrorEnvelope>;
  return typeof candidate.code === "string"
    && Object.prototype.hasOwnProperty.call(DEFINITIONS, candidate.code)
    && typeof candidate.message === "string"
    && typeof candidate.retryable === "boolean";
}
