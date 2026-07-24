import { z } from "zod";

export const CATALOGUE_PROTOCOL_VERSION = 1 as const;
export const CLAUDE_PROVIDER_INSTANCE_ID = "claudeAgent" as const;
export const DEFAULT_CATALOGUE_PAGE_LIMIT = 50;
export const MAX_CATALOGUE_PAGE_LIMIT = 200;

export const CatalogueActivityWindowSchema = z.enum(["today", "7d", "30d", "all"]);
export type CatalogueActivityWindow = z.infer<typeof CatalogueActivityWindowSchema>;

export const CatalogueSortSchema = z.enum(["nativeActivity", "cwd", "title"]);
export type CatalogueSort = z.infer<typeof CatalogueSortSchema>;

export const CatalogueFreshnessModeSchema = z.enum(["allow-stale", "require-fresh"]);
export type CatalogueFreshnessMode = z.infer<typeof CatalogueFreshnessModeSchema>;

export const RootSessionQuerySchema = z
  .object({
    query: z.string().trim().max(256).optional(),
    cwd: z.string().trim().min(1).max(4096).optional(),
    cwdPrefix: z.string().trim().min(1).max(4096).optional(),
    projectRoot: z.string().trim().min(1).max(4096).optional(),
    activityWindow: CatalogueActivityWindowSchema.default("all"),
    sort: CatalogueSortSchema.default("nativeActivity"),
    limit: z.number().int().min(1).max(MAX_CATALOGUE_PAGE_LIMIT).default(DEFAULT_CATALOGUE_PAGE_LIMIT),
    cursor: z.string().min(1).max(4096).optional(),
    freshness: CatalogueFreshnessModeSchema.default("allow-stale"),
  })
  .strict();
export type RootSessionQuery = z.infer<typeof RootSessionQuerySchema>;

export const SourceLookupSchema = z
  .object({
    resumeId: z.string().trim().min(1).max(128),
    cwd: z.string().trim().min(1).max(4096),
  })
  .strict();
export type SourceLookup = z.infer<typeof SourceLookupSchema>;

export type CatalogueFreshness = "uninitialized" | "fresh" | "stale";
export type CatalogueRefreshPhase = "idle" | "refreshing" | "error";

export interface CatalogueRefreshStats {
  readonly scanned: number;
  readonly parsed: number;
  readonly skipped: number;
  readonly removed: number;
}

export interface CatalogueSourceStatus {
  readonly generation: number;
  readonly phase: CatalogueRefreshPhase;
  readonly freshness: CatalogueFreshness;
  readonly indexedAt: string | null;
  readonly refreshedAt: string | null;
  readonly ageMs: number | null;
  readonly staleAfterMs: number;
  readonly rowCount: number;
  readonly lastError: { readonly at: string; readonly message: string } | null;
  readonly lastRefresh: CatalogueRefreshStats;
}

export interface CatalogueRootSession {
  readonly providerInstanceId: typeof CLAUDE_PROVIDER_INSTANCE_ID;
  readonly localSourceHost: string;
  readonly nativeSessionId: string;
  readonly sourceCwd: string;
  readonly projectRoot: string;
  readonly projectName: string;
  readonly title: string;
  readonly titleSource: "native" | "codex" | "fallback";
  readonly branch: string | null;
  readonly firstActivityAt: string | null;
  readonly latestActivityAt: string | null;
  readonly messageCount: number;
  readonly observedSize: number;
  readonly observedMtimeMs: number;
}

export interface RootSessionPage {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly sessions: readonly CatalogueRootSession[];
  readonly nextCursor: string | null;
  readonly sourceStatus: CatalogueSourceStatus;
}

export interface VerifiedCatalogueSource extends CatalogueRootSession {
  readonly sourcePath: string;
  readonly fileIdentity: string;
}

export interface SourceLookupResult {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly source: VerifiedCatalogueSource;
  readonly sourceStatus: CatalogueSourceStatus;
}

export interface SourceStatusResult {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly sourceStatus: CatalogueSourceStatus;
}

export interface CatalogueHealthResult extends SourceStatusResult {
  readonly service: {
    readonly pid: number;
    readonly instanceId: string;
    readonly startedAt: string;
    readonly idleTimeoutMs: number;
  };
}

export const CatalogueErrorCodeSchema = z.enum([
  "bad_request",
  "invalid_resume_id",
  "invalid_cwd",
  "source_not_found",
  "source_ambiguous",
  "cwd_mismatch",
  "source_changed",
  "refresh_failed",
  "stale_cursor",
  "not_found",
  "internal_error",
]);
export type CatalogueErrorCode = z.infer<typeof CatalogueErrorCodeSchema>;

export interface CatalogueProtocolError {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly error: {
    readonly code: CatalogueErrorCode;
    readonly message: string;
  };
}

export interface CatalogueRefreshResult {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly sourceStatus: CatalogueSourceStatus;
  readonly stats: CatalogueRefreshStats;
  readonly totalBytes: number;
  readonly totalCostUSD: number;
  readonly storePath: string;
  readonly host: string;
  readonly titles: {
    readonly generated: number;
    readonly failed: number;
    readonly skippedUnavailable: boolean;
  } | null;
}

export interface CatalogueMutationResult {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly saved: true;
}

export interface CatalogueShutdownResult {
  readonly protocolVersion: typeof CATALOGUE_PROTOCOL_VERSION;
  readonly stopping: true;
}
