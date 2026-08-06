import type { SidebarSnapshot } from "../projection.ts";

export type SnapshotFailure =
  | { readonly kind: "deadline"; readonly message: "Sidebar refresh timed out." }
  | { readonly kind: "refused"; readonly message: "Sidebar server is not accepting connections." }
  | { readonly kind: "http"; readonly status: number; readonly message: string }
  | { readonly kind: "malformed"; readonly message: "Sidebar server returned an invalid snapshot." };

export type SnapshotTransportResult =
  | { readonly kind: "changed"; readonly snapshot: SidebarSnapshot }
  | { readonly kind: "unchanged"; readonly snapshot: SidebarSnapshot }
  | { readonly kind: "failure"; readonly error: SnapshotFailure };

export interface SnapshotTransport {
  load(url: string, refreshLiveness?: boolean): Promise<SnapshotTransportResult>;
}

export type SnapshotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SnapshotTransportOptions {
  readonly deadlineMs?: number;
  readonly fetch?: SnapshotFetch;
}

const DEFAULT_DEADLINE_MS = 4_000;

type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

function isSnapshot(
  value: JsonValue | SidebarSnapshot,
): value is SidebarSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as JsonObject & Partial<SidebarSnapshot>;
  return Array.isArray(candidate.rows)
    && typeof candidate.livenessReadable === "boolean"
    && typeof candidate.indexReadable === "boolean"
    && typeof candidate.catalogueReadable === "boolean"
    && typeof candidate.hasMoreRows === "boolean"
    && typeof candidate.generatedAt === "number"
    && candidate.lifecycleCounts !== null
    && typeof candidate.lifecycleCounts === "object";
}

function httpMessage(status: number): string {
  return `Sidebar refresh failed with HTTP ${status}.`;
}

interface CachedSnapshot {
  readonly etag: string;
  readonly snapshot: SidebarSnapshot;
}

/** A typed conditional-GET client that retains one validated representation per exact URL. */
export function createSnapshotTransport(
  options: SnapshotTransportOptions = {},
): SnapshotTransport {
  const request = options.fetch ?? fetch;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const cache = new Map<string, CachedSnapshot>();

  return {
    async load(url: string, refreshLiveness = false): Promise<SnapshotTransportResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      const cached = cache.get(url);
      try {
        const headers: Record<string, string> = {};
        if (cached) headers["if-none-match"] = cached.etag;
        if (refreshLiveness) headers["x-ccs-refresh-liveness"] = "1";
        const response = await request(url, {
          signal: controller.signal,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        });
        if (response.status === 304) {
          return cached
            ? { kind: "unchanged", snapshot: cached.snapshot }
            : {
              kind: "failure",
              error: { kind: "malformed", message: "Sidebar server returned an invalid snapshot." },
            };
        }
        if (!response.ok) {
          return {
            kind: "failure",
            error: { kind: "http", status: response.status, message: httpMessage(response.status) },
          };
        }

        let parsed: JsonValue | SidebarSnapshot;
        try {
          parsed = await response.json() as JsonValue | SidebarSnapshot;
        } catch {
          return {
            kind: "failure",
            error: { kind: "malformed", message: "Sidebar server returned an invalid snapshot." },
          };
        }
        if (!isSnapshot(parsed)) {
          return {
            kind: "failure",
            error: { kind: "malformed", message: "Sidebar server returned an invalid snapshot." },
          };
        }

        const nextEtag = response.headers.get("etag");
        if (nextEtag !== null) cache.set(url, { etag: nextEtag, snapshot: parsed });
        else cache.delete(url);
        return { kind: "changed", snapshot: parsed };
      } catch {
        if (controller.signal.aborted) {
          return {
            kind: "failure",
            error: { kind: "deadline", message: "Sidebar refresh timed out." },
          };
        }
        return {
          kind: "failure",
          error: { kind: "refused", message: "Sidebar server is not accepting connections." },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** One-second polling stays the first retry; only consecutive failures increase the delay. */
export function snapshotPollDelay(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 1_000;
  return Math.min(30_000, 1_000 * (2 ** Math.min(consecutiveFailures, 5)));
}
