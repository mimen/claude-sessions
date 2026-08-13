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
  /**
   * Which refusal this was, from CCS's closed set of them.
   *
   * `message` describes a class of failure and is written before anything happens; a refusal code
   * is produced by the attempt. It is a code rather than the outcome's free-text reason because
   * reasons can carry absolute paths and database errors, which must never reach a client.
   */
  readonly refusal?: string;
}

/** A sentence for each refusal a person can do something about. */
export function refusalMessage(refusal: string | undefined): string | null {
  switch (refusal) {
    case "shared-workspace":
      return "Another session shares this workspace, so CCS will not close it.";
    case "not-primary-surface":
      return "This session is not the workspace's primary surface, so closing it would take the others with it.";
    case "session-not-live":
      return "That session is no longer running.";
    case "ambiguous-session-target":
      return "CCS could not tell which workspace this session means.";
    case "session-workspace-mismatch":
    case "session-surface-mismatch":
    case "hook-workspace-mismatch":
      return "The session and its workspace disagree about where it lives. Refresh the list.";
    default:
      return null;
  }
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
